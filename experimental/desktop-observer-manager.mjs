import { createObserver } from './app-server-observer.mjs';
import { desktopMcpAdapter } from './desktop-mcp-adapter.mjs';
import { isManagedTask, validateProxyConfig } from './desktop-proxy-config.mjs';

const events = new Set(['thread/started', 'thread/status/changed', 'turn/started', 'turn/completed']);

// Serialize the small native-tool transactions across tasks: bounded work and no
// competing snapshots/writes. No task text, sessions scan or model invocation.
export function createDesktopObserverManager(rpc, { readConfig, apply = true }) {
  const observers = new Map();
  const pending = new Map();
  let queue = Promise.resolve(), pumping = false, currentId = null;
  let scan = null, offset = 0, currentRecovery = false;
  const isStart = m => m.method === 'turn/started' || m.params?.status?.type === 'active'
    || (m.method === 'thread/started' && m.params?.thread?.status?.type === 'active');
  async function pump() {
    try {
      while (pending.size) {
        const [id, entry] = pending.entries().next().value;
        pending.delete(id); currentId = id; currentRecovery = !entry.latest;
        try {
          const config = validateProxyConfig(readConfig());
          if (!isManagedTask(config, id)) {
            observers.delete(id); entry.resolve({ action: 'skipped' }); continue;
          }
          if (!observers.has(id) || currentRecovery) {
            if (!observers.has(id) && observers.size >= 256) { entry.resolve({ action: 'skipped', reason: 'task-limit' }); continue; }
            const guarded = { request(method, params) {
              const current = validateProxyConfig(readConfig());
              if (!isManagedTask(current, id) || (currentRecovery && (current.reconcileIntervalSeconds === 0
                  || !isManagedTask(current, entry.context)))) throw Error('Policy changed');
              return rpc.request(method, params);
            } };
            observers.set(id, createObserver(desktopMcpAdapter(guarded, id,
              { contextThreadId: currentRecovery ? entry.context : id }), { threadIds: [id], apply }));
          }
          const observer = observers.get(id);
          // Preserve the original server start notification when a burst has
          // already coalesced to completion. Never manufacture lifecycle events.
          let result = entry.latest ? await observer.handle(entry.start ?? entry.latest) : await observer.reconcile(id);
          if (entry.start && entry.start !== entry.latest) result = await observer.handle(entry.latest);
          if (currentRecovery || result.action === 'skipped' || ((entry.latest?.method === 'turn/completed')
              && ['moved', 'unchanged'].includes(result.action))) observers.delete(id);
          entry.resolve(result);
        } catch (error) { observers.delete(id); entry.reject(error); }
      }
    } finally { currentId = null; pumping = false; }
  }
  function enqueue(id, message = null, context = null) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return Promise.resolve({ action: 'skipped' });
    let entry = pending.get(id);
    if (!entry) {
      // Never discard terminal updates for a task already being observed.
      if (pending.size >= 256 && !observers.has(id) && id !== currentId) {
        return Promise.resolve({ action: 'skipped', reason: 'task-limit' });
      }
      entry = {};
      entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      pending.set(id, entry);
    }
    if (message) entry.latest = message;
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
      if (scan) return scan;
      scan = Promise.resolve().then(async () => {
        const config = validateProxyConfig(readConfig());
        if (config.mode === 'disabled' || config.reconcileIntervalSeconds === 0) return { action: 'disabled' };
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
          try { candidates = await desktopMcpAdapter(guarded, id).candidates(); context = id; break; } catch { /* Try another loaded context. */ }
        }
        if (!candidates) return { action: 'unavailable', reason: 'no-native-context' };
        const ids = candidates.filter(id => isManagedTask(config, id));
        const result = { action: 'reconciled', candidates: ids.length, checked: 0, moved: 0, errors: 0 };
        const deadline = Date.now() + 10000;
        // Round-robin bounded batches. Events and repairs share the same write queue.
        const start = offset % (ids.length || 1);
        for (let n = 0; n < Math.min(20, ids.length) && Date.now() < deadline; n++) {
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
  };
}
