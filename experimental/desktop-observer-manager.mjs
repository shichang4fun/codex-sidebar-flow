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
  const isStart = m => m.method === 'turn/started' || m.params?.status?.type === 'active'
    || (m.method === 'thread/started' && m.params?.thread?.status?.type === 'active');
  async function pump() {
    try {
      while (pending.size) {
        const [id, entry] = pending.entries().next().value;
        pending.delete(id); currentId = id;
        try {
          const config = validateProxyConfig(readConfig());
          if (!isManagedTask(config, id)) {
            observers.delete(id); entry.resolve({ action: 'skipped' }); continue;
          }
          if (!observers.has(id)) {
            if (observers.size >= 256) { entry.resolve({ action: 'skipped', reason: 'task-limit' }); continue; }
            const guarded = { request(method, params) {
              if (!isManagedTask(validateProxyConfig(readConfig()), id)) throw Error('Policy changed');
              return rpc.request(method, params);
            } };
            observers.set(id, createObserver(desktopMcpAdapter(guarded, id), { threadIds: [id], apply }));
          }
          const observer = observers.get(id);
          // Preserve the original server start notification when a burst has
          // already coalesced to completion. Never manufacture lifecycle events.
          let result = await observer.handle(entry.start ?? entry.latest);
          if (entry.start && entry.start !== entry.latest) result = await observer.handle(entry.latest);
          if (result.action === 'skipped' || (entry.latest.method === 'turn/completed'
              && ['moved', 'unchanged'].includes(result.action))) observers.delete(id);
          entry.resolve(result);
        } catch (error) { observers.delete(id); entry.reject(error); }
      }
    } finally { currentId = null; pumping = false; }
  }
  return {
    handle(message) {
      if (!events.has(message.method)) return Promise.resolve({ action: 'skipped' });
      const id = message.method === 'thread/started' ? message.params?.thread?.id : message.params?.threadId;
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
      entry.latest = message;
      if (isStart(message)) entry.start = message;
      if (!pumping) { pumping = true; queue = Promise.resolve().then(pump); }
      return entry.promise;
    },
    drain() { return queue; },
  };
}
