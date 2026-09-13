import { createObserver } from './app-server-observer.mjs';
import { desktopMcpAdapter } from './desktop-mcp-adapter.mjs';
import { isManagedTask, validateProxyConfig } from './desktop-proxy-config.mjs';

const events = new Set(['thread/started', 'thread/status/changed', 'turn/started', 'turn/completed']);

// A small event projection, not a membership/status cache used to authorize moves.
// Missing/unknown data cannot prove duplicates. A first explicit turn ID is a
// new version, never assumed to belong to an earlier anonymous active event.
function eventState(message, previous) {
  const turn = message.params?.turn;
  if (message.method === 'turn/started' || message.method === 'turn/completed') {
    if (typeof turn?.id !== 'string' || !turn.id || turn.id.length > 128) return null;
    const phase = message.method === 'turn/started' ? 'active'
      : ['completed', 'interrupted', 'failed'].includes(turn.status) ? turn.status : null;
    return phase ? { phase, turnId: turn.id } : null;
  }
  const status = message.method === 'thread/started' ? message.params?.thread?.status : message.params?.status;
  let phase = status?.type;
  if (phase === 'active') {
    if (!Array.isArray(status.activeFlags)
        || status.activeFlags.some(f => !['waitingOnApproval', 'waitingOnUserInput'].includes(f))) return null;
    phase = ['active', ...new Set(status.activeFlags)].sort().join(':');
  } else if (!['idle', 'systemError'].includes(phase)) return null;
  return { phase, turnId: previous?.turnId ?? null };
}
const sameState = (a, b) => a && b && a.phase === b.phase && a.turnId === b.turnId;
const superseded = () => Object.assign(Error('DESKTOP_RECONCILIATION_SUPERSEDED'), { code: 'DESKTOP_RECONCILIATION_SUPERSEDED' });

// Project event state synchronously; serialize only the guarded native-tool
// transactions. No task text interpretation, sessions scan or model invocation.
export function createDesktopObserverManager(rpc, { readConfig, apply = true,
  setTimer = setTimeout, clearTimer = clearTimeout, onRetry = () => {},
  now = () => performance.now(), onTiming = () => {} }) {
  const observers = new Map();
  const pending = new Map();
  const retries = new Map();
  const retryDelays = [250, 750, 2000, 5000];
  const retryable = new Set(['DESKTOP_MCP_UNAVAILABLE', 'TASK_NOT_VISIBLE', 'MEMBERSHIP_NOT_READY']);
  let stopped = false;
  let queue = Promise.resolve(), pumping = false, currentId = null, currentEntry = null;
  let scan = null, offset = 0, currentRecovery = false;
  let currentTiming = null;
  // One summary per queue entry, never tool arguments, task text or raw errors.
  // The manager is serial; reused observers must charge the current entry.
  async function measuredRequest(method, params) {
    const timing = currentTiming;
    const tool = method === 'mcpServer/tool/call' ? params.tool : method;
    const started = now();
    try { return await rpc.request(method, params); }
    finally {
      if (timing && ['list_threads', 'read_thread', 'move_thread_to_sidebar_section'].includes(tool)) {
        timing.rpcCounts[tool] = (timing.rpcCounts[tool] ?? 0) + 1;
        timing.rpcMs[tool] = (timing.rpcMs[tool] ?? 0) + Math.max(0, now() - started);
        if (tool === 'move_thread_to_sidebar_section') timing.moveAfterMs = Math.max(0, now() - timing.queuedAt);
      }
    }
  }
  const lifecycleBusy = () => (currentId !== null && !currentRecovery)
    || [...pending.values()].some(entry => entry.latest);
  const isStart = m => m.method === 'turn/started' || m.params?.status?.type === 'active'
    || (m.method === 'thread/started' && m.params?.thread?.status?.type === 'active');
  function consumeRetry(id, entry) {
    const retry = retries.get(id);
    if (!retry) return;
    clearTimer(retry.timer); retries.delete(id);
    entry.start ??= retry.start;
    entry.latest ??= retry.latest;
    entry.retryAttempt = Math.max(entry.retryAttempt ?? 0, retry.retryAttempt);
  }
  async function pump() {
    try {
      while (pending.size) {
        const [id, entry] = pending.entries().next().value;
        // A preceding in-flight read may have failed after this entry queued.
        consumeRetry(id, entry);
        pending.delete(id); currentId = id; currentRecovery = !entry.latest;
        currentEntry = entry;
        const startedAt = now();
        const timing = currentTiming = { queuedAt: entry.queuedAt, rpcCounts: {}, rpcMs: {}, moveAfterMs: null };
        let action = 'error';
        try {
          const config = validateProxyConfig(readConfig());
          if (stopped || !isManagedTask(config, id)) {
            observers.delete(id); action = 'skipped'; entry.resolve({ action }); continue;
          }
          if (!observers.has(id) || currentRecovery) {
            if (!observers.has(id) && observers.size >= 256) { action = 'skipped'; entry.resolve({ action, reason: 'task-limit' }); continue; }
            const guarded = { async request(method, params) {
              const current = validateProxyConfig(readConfig());
              if (stopped || !isManagedTask(current, id) || (currentRecovery && (current.reconcileIntervalSeconds === 0
                  || !isManagedTask(current, entry.context)))) throw Error('Policy changed');
              // Capture the running transaction, not a mutable latest version.
              const transaction = currentEntry;
              const check = () => {
                if (transaction?.superseded && !transaction.writeDispatched) throw superseded();
              };
              check();
              if (params.tool === 'move_thread_to_sidebar_section') transaction.writeDispatched = true;
              try { return await measuredRequest(method, params); }
              finally {
                // Even a failed slow read must not retry an obsolete start.
                // Once a write is dispatched, still finish its fresh readback.
                check();
              }
            } };
            observers.set(id, createObserver(desktopMcpAdapter(guarded, id,
              { contextThreadId: currentRecovery ? entry.context : id }), { threadIds: [id], apply, allowProjectTasks: true }));
          }
          const observer = observers.get(id);
          // Preserve the original server start notification when a burst has
          // already coalesced to completion. Never manufacture lifecycle events.
          // A successful handle(start) already reads the latest state. Avoid a
          // redundant second transaction, but retain it if a between-read race
          // skipped the first. In-flight duplicates share this transaction;
          // material lifecycle changes always have a separate successor.
          let result = entry.latest ? await observer.handle(entry.start ?? entry.latest) : await observer.reconcile(id);
          if (entry.start && entry.start !== entry.latest && result.action === 'skipped') {
            result = await observer.handle(entry.latest);
          }
          if (currentRecovery || result.action === 'skipped' || ((entry.latest?.method === 'turn/completed')
              && ['moved', 'unchanged'].includes(result.action))) observers.delete(id);
          action = result.action; entry.resolve(result);
        } catch (error) {
          if (error.code === 'DESKTOP_RECONCILIATION_SUPERSEDED') {
            // Recovery may borrow another task's native-tool context. A real
            // lifecycle successor must rebuild with its own target context.
            if (currentRecovery) observers.delete(id);
            action = 'superseded';
            entry.resolve({ action: 'skipped', reason: 'superseded' });
            continue;
          }
          const attempt = entry.retryAttempt ?? 0;
          if (!stopped && entry.latest && retryable.has(error.code) && attempt < retryDelays.length && retries.size < 256) {
            const retry = { latest: entry.latest, start: entry.start, retryAttempt: attempt + 1 };
            retry.timer = setTimer(() => {
              if (retries.get(id) !== retry) return;
              // enqueue transfers real start evidence and cancels this timer.
              enqueue(id, retry.latest).then(onRetry).catch(() => {});
            }, retryDelays[attempt]);
            retry.timer?.unref?.();
            retries.set(id, retry);
            // New-task failures need only their actual start notification, not
            // an observer slot. Retain an existing observer only when its prior
            // successful activity is the sole evidence for an idle retry.
            if (entry.start) observers.delete(id);
          } else observers.delete(id);
          entry.reject(error);
        } finally {
          const endedAt = now();
          currentTiming = null;
          try {
            onTiming({ at: new Date().toISOString(), receivedAt: entry.receivedAt, threadId: id,
              event: entry.latest?.method ?? 'reconciliation', notifications: entry.notifications,
              attempt: entry.retryAttempt ?? 0, queueMs: Math.max(0, startedAt - entry.queuedAt),
              executionMs: Math.max(0, endedAt - startedAt), rpcCounts: timing.rpcCounts, rpcMs: timing.rpcMs,
              moveAfterMs: timing.moveAfterMs,
              readbackMs: timing.moveAfterMs === null ? null : Math.max(0, endedAt - entry.queuedAt - timing.moveAfterMs), action });
          } catch { /* Diagnostics must never alter task handling. */ }
        }
      }
    } finally { currentId = null; currentEntry = null; pumping = false; }
  }
  function enqueue(id, message = null, context = null) {
    if (stopped || typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return Promise.resolve({ action: 'skipped' });
    let entry = pending.get(id);
    const running = currentId === id ? currentEntry : null;
    const state = message ? eventState(message, entry?.state ?? running?.state) : null;
    if (message && !entry && running && !running.superseded && sameState(state, running.state)) {
      running.notifications++;
      if (isStart(message)) running.start ??= message;
      return running.promise;
    }
    if (!entry) {
      // Never discard terminal updates for a task already being observed.
      if (pending.size >= 256 && !observers.has(id) && id !== currentId) {
        return Promise.resolve({ action: 'skipped', reason: 'task-limit' });
      }
      entry = { queuedAt: now(), receivedAt: new Date().toISOString(), notifications: 0 };
      entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      pending.set(id, entry);
    }
    consumeRetry(id, entry);
    if (message) {
      // This executes on notification arrival, even while another RPC awaits.
      entry.latest = message; entry.state = state; entry.notifications++;
      if (running) {
        running.superseded = true;
        entry.start ??= running.start;
      }
    }
    if (context) entry.context = context;
    if (message && isStart(message)) entry.start = message;
    if (!pumping) { pumping = true; queue = Promise.resolve().then(pump); }
    return entry.promise;
  }
  return {
    handle(message) {
      if (!events.has(message.method)) return Promise.resolve({ action: 'skipped' });
      return enqueue(message.method === 'thread/started' ? message.params?.thread?.id : message.params?.threadId, message);
    },
    reconcile() {
      if (stopped) return Promise.resolve({ action: 'disabled' });
      if (scan) return scan;
      scan = Promise.resolve().then(async () => {
        const config = validateProxyConfig(readConfig());
        if (config.mode === 'disabled' || config.reconcileIntervalSeconds === 0) return { action: 'disabled' };
        if (lifecycleBusy()) return { action: 'deferred', reason: 'lifecycle-busy' };
        const guarded = { request(method, params) {
          const current = validateProxyConfig(readConfig());
          if (current.mode === 'disabled' || current.reconcileIntervalSeconds === 0
              || (params.threadId && !isManagedTask(current, params.threadId))) throw Error('Reconciliation disabled');
          return rpc.request(method, params);
        } };
        // Read already-loaded local sessions; never start/resume a task to obtain a context.
        const loaded = await guarded.request('thread/loaded/list', { limit: 1000 });
        if (!Array.isArray(loaded?.data)) throw Error('Invalid loaded task list');
        const contexts = loaded.data.filter(id => isManagedTask(config, id)).slice(0, 3);
        let candidates, context;
        for (const id of contexts) {
          if (lifecycleBusy()) return { action: 'deferred', reason: 'lifecycle-busy' };
          try { candidates = await desktopMcpAdapter(guarded, id).candidates(); context = id; break; } catch { /* Try another loaded context. */ }
        }
        if (!candidates) return { action: 'unavailable', reason: 'no-native-context' };
        const ids = candidates.filter(id => isManagedTask(config, id));
        const result = { action: 'reconciled', candidates: ids.length, checked: 0, moved: 0, errors: 0 };
        const deadline = Date.now() + 10000;
        // Round-robin bounded batches. Events and repairs share the same write queue.
        const start = offset % (ids.length || 1);
        for (let n = 0; n < Math.min(20, ids.length) && Date.now() < deadline; n++) {
          if (lifecycleBusy()) return { ...result, action: 'deferred', reason: 'lifecycle-busy' };
          const current = validateProxyConfig(readConfig());
          if (current.mode === 'disabled' || current.reconcileIntervalSeconds === 0) break;
          const id = ids[(start + n) % ids.length];
          offset = start + n + 1;
          try { if ((await enqueue(id, null, context)).action === 'moved') result.moved++; } catch { result.errors++; }
          result.checked++;
        }
        return result;
      }).finally(() => { scan = null; });
      return scan;
    },
    drain() { return queue; },
    stop() {
      stopped = true;
      for (const retry of retries.values()) clearTimer(retry.timer);
      retries.clear(); observers.clear();
    },
  };
}
