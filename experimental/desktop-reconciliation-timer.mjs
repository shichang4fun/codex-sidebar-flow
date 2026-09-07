import { validateProxyConfig } from './desktop-proxy-config.mjs';

// One timer inside the existing proxy, never a model heartbeat or another daemon.
export function startReconciliation(manager, {
  readConfig, log, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let stopped = false, timer;
  const schedule = delay => { timer = setTimer(tick, delay); timer?.unref?.(); };
  async function tick() {
    if (stopped) return;
    try {
      const config = validateProxyConfig(readConfig());
      if (config.mode !== 'disabled' && config.reconcileIntervalSeconds !== 0) {
        const result = await manager.reconcile();
        if (!stopped) log({ reconciliation: result });
      }
    } catch { if (!stopped) log({ reconciliation: { action: 'error', code: 'RECONCILIATION_FAILED' } }); }
    if (stopped) return;
    let seconds = 60;
    try { seconds = validateProxyConfig(readConfig()).reconcileIntervalSeconds || 60; } catch { /* Retry config later. */ }
    schedule(seconds * 1000);
  }
  schedule(5000);
  return () => { stopped = true; clearTimer(timer); };
}
