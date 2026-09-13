#!/usr/bin/env node
// Opt-in, local-only experiment. Not installed by setup and not a Desktop adapter.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveConfiguredSections } from '../scripts/sidebar-policy.mjs';

export function localEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || !url.port || url.username || url.password || url.search || url.hash) {
    throw Error('Explicit numeric loopback ws endpoint required; credentials/query not accepted');
  }
  return url.href;
}

// Node 22+ built-in WebSocket; no dependencies or private Desktop pipe discovery.
export async function connectRpc(endpoint, { timeoutMs = 5000 } = {}) {
  if (typeof WebSocket !== 'function') throw Error('Observer requires Node 22 or newer');
  const socket = new WebSocket(localEndpoint(endpoint));
  const pending = new Map();
  const listeners = new Set();
  let sequence = 0;
  let closed = false;
  function stop() {
    closed = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('RPC connection closed')); }
    pending.clear();
  }
  socket.addEventListener('close', stop);
  socket.addEventListener('error', stop);
  socket.addEventListener('message', ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { socket.close(); return; }
    if (message.id != null && pending.has(message.id)) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(p.timer);
      // Do not log server errors: they can contain private paths or task content.
      if (message.error) p.reject(Error(`RPC failed (${message.error.code})`));
      else p.resolve(message.result);
    } else if (message.id == null && typeof message.method === 'string') {
      for (const listener of listeners) listener(message);
    }
    // Never answer approval requests or other server-initiated requests.
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(Error('RPC connect timeout')); }, timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('RPC connect failed')); }, { once: true });
  });
  const rpc = {
    request(method, params = {}) {
      if (closed || socket.readyState !== WebSocket.OPEN) return Promise.reject(Error('RPC connection closed'));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error('RPC request timeout')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch { clearTimeout(timer); pending.delete(id); reject(Error('RPC send failed')); }
      });
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { stop(); socket.close(); },
  };
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'sidebar_flow_experiment', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: 'initialized' }));
    return rpc;
  } catch (error) { rpc.close(); throw error; }
}

export function createObserver(rpc, { threadIds, apply = false, excludeThreadIds = [], allowProjectTasks = false,
  allowForLaterStart = false } = {}) {
  if (!Array.isArray(threadIds) || threadIds.length === 0 || threadIds.length > 10
      || threadIds.some(id => typeof id !== 'string' || !id || id.length > 128)
      || new Set(threadIds).size !== threadIds.length) throw Error('1-10 explicit unique test thread IDs required');
  const allowed = new Set(threadIds.filter(id => !excludeThreadIds.includes(id)));
  const activeSeen = new Set();
  let queue = Promise.resolve();
  const names = { inProgress: 'In Progress', forReview: 'For Review', forLater: 'For Later' };

  function eligible(thread, id, sections) {
    if (!thread || thread.id !== id || (thread.projectId !== null
        && (!allowProjectTasks || typeof thread.projectId !== 'string' || !thread.projectId)) || thread.parentThreadId != null
        || thread.archived === true || thread.ephemeral === true) return null;
    if (thread.section !== null && (typeof thread.section?.id !== 'string' || !thread.section.id)) return null;
    // Desktop may release a directly deferred task only while it is running.
    // Idle/attention/unknown state stays protected, even with prior start evidence.
    const source = thread.section?.id ?? null;
    if (source === sections.forLater.sectionId) return allowForLaterStart
      && thread.status?.type === 'active' && Array.isArray(thread.status.activeFlags)
      && thread.status.activeFlags.length === 0;
    if (source !== null && ![sections.inProgress.sectionId, sections.forReview.sectionId].includes(source)) return null;
    return true;
  }
  function destination(thread, id, sections) {
    if (!eligible(thread, id, sections)) return null;
    const status = thread.status;
    if (status?.type === 'active') {
      if (!Array.isArray(status.activeFlags)
          || status.activeFlags.some(f => !['waitingOnApproval', 'waitingOnUserInput'].includes(f))) return null;
      return status.activeFlags.length ? sections.forReview.sectionId : sections.inProgress.sectionId;
    }
    if (['idle', 'systemError'].includes(status?.type)
        && (activeSeen.has(id) || thread.section?.id === sections.inProgress.sectionId)) return sections.forReview.sectionId;
    return null;
  }

  async function reconcile(id, message = null, client = rpc) {
    if (!allowed.has(id)) return { action: 'skipped' };
    const result = await client.request('threadSection/list');
    const sections = resolveConfiguredSections(result.data?.map(s => ({ sectionId: s.id, name: s.name })), names);
    const read = async () => (await client.request('thread/read', { threadId: id, includeTurns: false })).thread;
    const thread = await read();
    // Only these messages from the connected server are activity evidence, never
    // user text. Preserve a short turn's start even if the current read is idle.
    const eventStatus = message?.method === 'thread/status/changed' ? message.params?.status
      : message?.method === 'thread/started' ? message.params?.thread?.status : null;
    if (eligible(thread, id, sections) && (message?.method === 'turn/started' || (eventStatus?.type === 'active'
        && Array.isArray(eventStatus.activeFlags)
        && eventStatus.activeFlags.every(f => ['waitingOnApproval', 'waitingOnUserInput'].includes(f))))) activeSeen.add(id);
    const target = destination(thread, id, sections);
    if (!target) return { action: 'skipped' };
    if (thread.status.type === 'active') activeSeen.add(id);
    if (thread.section?.id === target) return { action: 'unchanged' };
    if (!apply) return { action: 'would-move', sectionId: target };
    const latest = await read();
    if (latest?.section?.id !== thread.section?.id || destination(latest, id, sections) !== target) {
      return { action: 'skipped' };
    }
    // API has no conditional move. This final read narrows, but cannot eliminate, the race.
    await client.request('thread/section/move', { threadId: id, sectionId: target });
    const after = await read();
    if (after?.section?.id !== target) throw Error('Server section readback mismatch');
    return { action: 'moved', sectionId: target, desktopVerified: false };
  }
  function runReconciliation(id, message) {
    return typeof rpc.withReconciliation === 'function'
      ? rpc.withReconciliation(client => reconcile(id, message, client))
      : reconcile(id, message);
  }
  return {
    handle(message) {
      if (!['thread/status/changed', 'thread/started', 'turn/started', 'turn/completed'].includes(message.method)) {
        return Promise.resolve({ action: 'skipped' });
      }
      const id = message.method === 'thread/started' ? message.params?.thread?.id : message.params?.threadId;
      const result = queue.then(() => runReconciliation(id, message));
      queue = result.catch(() => {});
      return result;
    },
    // Explicit snapshot path: never invent a lifecycle event or start evidence.
    reconcile(id) {
      const result = queue.then(() => runReconciliation(id));
      queue = result.catch(() => {});
      return result;
    },
    drain() { return queue; },
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    url: { type: 'string' }, thread: { type: 'string', multiple: true },
    exclude: { type: 'string', multiple: true },
    'apply-test-only': { type: 'boolean', default: false },
    seconds: { type: 'string', default: '30' },
  } });
  const seconds = Number(values.seconds);
  if (!values.url || !Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
    throw Error('Use --url ws://127.0.0.1:PORT --thread TEST_ID [--seconds 1..300] [--apply-test-only]');
  }
  // Validate the allowlist before connecting.
  createObserver({}, { threadIds: values.thread });
  const rpc = await connectRpc(values.url);
  const observer = createObserver(rpc, { threadIds: values.thread, apply: values['apply-test-only'], excludeThreadIds: values.exclude });
  let events = 0;
  let errors = 0;
  const log = value => process.stdout.write(JSON.stringify(value) + '\n');
  const unsubscribe = rpc.subscribe(message => {
    if (!['thread/status/changed', 'thread/started', 'turn/started', 'turn/completed'].includes(message.method)) return;
    events++;
    observer.handle(message).then(result => log({ event: message.method, ...result }), () => {
      errors++; log({ error: 'OBSERVER_RPC_FAILED' });
    });
  });
  try {
    // Intentionally no thread/resume: never load a second copy of a Desktop task.
    for (const id of values.thread) {
      const { thread } = await rpc.request('thread/read', { threadId: id, includeTurns: false });
      log({ phase: 'probe', status: thread?.status?.type ?? 'unknown', desktopVerified: false });
    }
    await new Promise(resolve => {
      const timer = setTimeout(finish, seconds * 1000);
      function finish() { clearTimeout(timer); process.off('SIGINT', finish); process.off('SIGTERM', finish); resolve(); }
      process.once('SIGINT', finish); process.once('SIGTERM', finish);
    });
  } finally {
    unsubscribe(); await observer.drain(); rpc.close();
    log({ phase: 'summary', events, errors, desktopVerified: false });
    if (errors) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('OBSERVER_FAILED: check arguments, Node version and local endpoint\n'); process.exitCode = 1; });
}
