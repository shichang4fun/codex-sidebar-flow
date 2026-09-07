import test from 'node:test';
import assert from 'node:assert/strict';

test('timer runs at 60-second completion intervals, reloads disable and stops without overlaps', async () => {
  const { startReconciliation } = await import('../experimental/desktop-reconciliation-timer.mjs');
  let config = { version: 1, mode: 'all-local' }, calls = 0;
  const timers = new Map(), logs = [];
  const stop = startReconciliation({ async reconcile() { calls++; return { action: 'reconciled', moved: 0 }; } }, {
    readConfig: () => config, log: value => logs.push(value),
    setTimer(fn, delay) { timers.set(fn, delay); return fn; }, clearTimer: fn => timers.delete(fn),
  });
  const tick = async () => { const [fn, delay] = timers.entries().next().value; timers.delete(fn); await fn(); return delay; };
  assert.equal(await tick(), 5000);
  assert.equal(calls, 1);
  assert.equal(await tick(), 60000);
  config = { ...config, reconcileIntervalSeconds: 0 };
  await tick(); assert.equal(calls, 2);
  config = { version: 1, mode: 'disabled' };
  await tick(); assert.equal(calls, 2);
  config = { version: 1, mode: 'all-local', reconcileIntervalSeconds: 15 };
  await tick(); assert.equal(calls, 3);
  assert.equal(timers.size, 1); assert.equal([...timers.values()][0], 15000);
  stop(); assert.equal(timers.size, 0);
  assert.ok(logs.some(l => l.reconciliation?.action === 'reconciled'));
});

test('stopping an in-flight timer does not schedule again; failures can retry', async () => {
  const { startReconciliation } = await import('../experimental/desktop-reconciliation-timer.mjs');
  let finish, scheduled;
  const logs = [];
  const stop = startReconciliation({ reconcile: () => new Promise(resolve => { finish = resolve; }) }, {
    readConfig: () => ({ version: 1, mode: 'all-local' }), log: value => logs.push(value),
    setTimer(fn) { scheduled = fn; return fn; }, clearTimer() { scheduled = null; },
  });
  const running = scheduled(); stop(); finish({ action: 'reconciled' }); await running;
  assert.equal(scheduled, null);
  const stopFailing = startReconciliation({ async reconcile() { throw Error('PRIVATE_ERROR'); } }, {
    readConfig: () => ({ version: 1, mode: 'all-local' }), log: value => logs.push(value),
    setTimer(fn) { scheduled = fn; return fn; }, clearTimer() { scheduled = null; },
  });
  const first = scheduled; await first();
  assert.notEqual(scheduled, null);
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_ERROR'));
  stopFailing();
});
