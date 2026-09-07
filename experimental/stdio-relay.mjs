import { randomUUID } from 'node:crypto';

const OBSERVER_METHODS = new Set([
  'thread/read', 'thread/loaded/list', 'threadSection/list', 'thread/section/move',
  'mcpServerStatus/list', 'mcpServer/tool/call',
]);

// JSON-RPC message relay, not an additional server. Original approvals, parameters,
// capabilities and notifications remain owned by the Desktop client.
export function createStdioRelay({ toServer, toDesktop, timeoutMs = 5000 }) {
  const namespace = `sidebar:${randomUUID()}:`;
  const desktop = new Map();
  const observer = new Map();
  const listeners = new Set();
  let sequence = 0;
  let ready = false;
  let closed = false;
  let observingStopped = false;
  function stopObserving() {
    observingStopped = true;
    for (const p of observer.values()) { clearTimeout(p.timer); p.reject(Error(closed ? 'Relay closed' : 'Observer stopped')); }
    observer.clear(); listeners.clear();
  }
  const next = kind => `${namespace}${kind}:${++sequence}`;
  return {
    fromDesktop(message) {
      if (closed) return;
      if (message.method && message.id != null) {
        const id = next('desktop');
        desktop.set(id, { originalId: message.id, method: message.method });
        toServer({ ...message, id });
      } else {
        toServer(message);
      }
    },
    fromServer(message) {
      if (closed) return;
      if (message.id != null && !message.method) {
        const entry = desktop.get(message.id);
        if (entry) {
          desktop.delete(message.id);
          // Desktop starts using the connection after initialize succeeds and
          // does not send initialized. Failed handshakes must remain closed.
          if (entry.method === 'initialize') ready = !message.error;
          toDesktop({ ...message, id: entry.originalId });
          return;
        }
        if (typeof message.id === 'string' && message.id.startsWith(`${namespace}observer:`)) {
          const pending = observer.get(message.id);
          if (pending) {
            observer.delete(message.id); clearTimeout(pending.timer);
            if (message.error) pending.reject(Error(`Observer RPC failed (${message.error.code})`));
            else pending.resolve(message.result);
          }
          // Late replies to timed-out internal calls must not leak into Desktop.
          return;
        }
      }
      toDesktop(message);
      if (ready && !observingStopped && message.id == null && message.method) {
        for (const listener of listeners) {
          try { Promise.resolve(listener(message)).catch(() => {}); } catch {}
        }
      }
    },
    request(method, params = {}) {
      if (closed) return Promise.reject(Error('Relay closed'));
      if (observingStopped) return Promise.reject(Error('Observer stopped'));
      if (!ready) return Promise.reject(Error('Desktop handshake not ready'));
      if (!OBSERVER_METHODS.has(method)) return Promise.reject(Error('Observer method not allowed'));
      if (observer.size >= 16) return Promise.reject(Error('Observer request limit reached'));
      const id = next('observer');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { observer.delete(id); reject(Error('Observer RPC timeout')); }, timeoutMs);
        observer.set(id, { resolve, reject, timer });
        try { toServer({ id, method, params }); }
        catch { clearTimeout(timer); observer.delete(id); reject(Error('Observer send failed')); }
      });
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    // On client EOF retain request-ID mappings and drain final server frames.
    stopObserving,
    close() {
      closed = true; ready = false;
      stopObserving(); desktop.clear();
    },
  };
}
