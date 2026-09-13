import test from 'node:test';
import assert from 'node:assert/strict';

import * as api from '../experimental/stdio-relay.mjs';
test('stdio relay API exists', () => assert.equal(typeof api.createStdioRelay, 'function'));

const listParams = (threadId = 'test') => ({ threadId, server: 'codex_app', tool: 'list_threads', arguments: { limit: 50 } });
function timedFixture() {
  const timers = new Map();
  const f = fixture({ setTimer(fn, delay) { timers.set(fn, delay); return fn; }, clearTimer(fn) { timers.delete(fn); } });
  f.initialize();
  function advance(ms) {
    for (const [fn, remaining] of [...timers]) {
      if (remaining <= ms) { timers.delete(fn); fn(); }
      else timers.set(fn, remaining - ms);
    }
  }
  return { ...f, timers, advance };
}

test('cold list read retains the native response past five seconds without duplicating the same-context call', async () => {
  const f = timedFixture();
  try {
    const first = f.relay.request('mcpServer/tool/call', listParams());
    const second = f.relay.request('mcpServer/tool/call', listParams());
    const settled = Promise.all([first, second]);
    settled.catch(() => {}); // Keep assertion-failure cleanup rejection handled.
    assert.equal(first, second);
    assert.deepEqual([...f.timers.values()], [35000]);
    assert.equal(f.upstream.filter(m => m.method === 'mcpServer/tool/call').length, 1);
    let finished = false;
    settled.finally(() => { finished = true; }).catch(() => {});
    f.advance(5000); await Promise.resolve();
    assert.equal(finished, false, 'The old deadline must not drop a cold response');
    f.advance(19000); await Promise.resolve();
    assert.equal(finished, false, 'The observed 24-second native wait must still have a listener');
    const result = { content: [{ type: 'text', text: '{"threads":[]}' }] };
    f.relay.fromServer({ id: f.upstream.at(-1).id, result });
    assert.deepEqual(await settled, [result, result]);
    assert.equal(f.timers.size, 0);
    // A new transaction must fetch again, never reuse a completed snapshot.
    const fresh = f.relay.request('mcpServer/tool/call', listParams());
    assert.notEqual(fresh, first);
    f.relay.fromServer({ id: f.upstream.at(-1).id, result: {} });
    await fresh;
  } finally { f.relay.close(); }
});

test('list coalescing never crosses context or arguments; writes keep separate five-second deadlines', async () => {
  const f = timedFixture();
  const params = listParams();
  const promises = [params, listParams('other'), { ...params, arguments: { limit: 10 } },
    { ...params, tool: 'move_thread_to_sidebar_section' }, { ...params, tool: 'move_thread_to_sidebar_section' }]
    .map(p => f.relay.request('mcpServer/tool/call', p));
  const settled = Promise.allSettled(promises);
  try {
    assert.deepEqual([...f.timers.values()], [35000, 35000, 35000, 5000, 5000]);
    assert.equal(f.upstream.filter(m => m.method === 'mcpServer/tool/call').length, 5);
  } finally { f.relay.stopObserving(); }
  assert.ok((await settled).every(r => r.status === 'rejected'));
  assert.equal(f.timers.size, 0);
});

test('cold list timeout is bounded, clears singleflight and hides late replies', async () => {
  const f = timedFixture();
  const pending = f.relay.request('mcpServer/tool/call', listParams());
  const rejected = assert.rejects(pending, /timeout/i);
  const id = f.upstream.at(-1).id;
  const fn = [...f.timers.keys()][0];
  assert.equal(typeof fn, 'function');
  f.timers.delete(fn); fn();
  await rejected;
  const fresh = f.relay.request('mcpServer/tool/call', listParams());
  assert.notEqual(fresh, pending);
  f.relay.fromServer({ id, result: { stale: true } });
  assert.equal(f.downstream.length, 1);
  f.relay.fromServer({ id: f.upstream.at(-1).id, result: { fresh: true } });
  assert.deepEqual(await fresh, { fresh: true });
  f.relay.close();
});

test('failed list responses and synchronous send failures release the in-flight entry', async () => {
  const f = timedFixture();
  const failed = f.relay.request('mcpServer/tool/call', listParams());
  f.relay.fromServer({ id: f.upstream.at(-1).id, error: { code: -32603 } });
  await assert.rejects(failed, /RPC failed/);
  const next = f.relay.request('mcpServer/tool/call', listParams());
  assert.notEqual(next, failed);
  f.relay.fromServer({ id: f.upstream.at(-1).id, result: {} });
  await next;
  assert.equal(f.timers.size, 0);
  f.relay.close();

  let broken = false, attempts = 0;
  const g = fixture({ toServer(message) {
    if (!broken) g.upstream.push(message);
    else { attempts++; throw Error('transport closed'); }
  } });
  g.initialize(); broken = true;
  await assert.rejects(g.relay.request('mcpServer/tool/call', listParams()), /send failed/);
  await assert.rejects(g.relay.request('mcpServer/tool/call', listParams()), /send failed/);
  assert.equal(attempts, 2);
  g.relay.close();
});

test('Desktop initialize response enables events without an initialized notification', async () => {
  const f = fixture();
  const events = [];
  f.relay.subscribe(message => events.push(message));
  f.relay.fromDesktop({ id: '__codex_initialize__', method: 'initialize', params: {} });
  f.relay.fromServer({ id: f.upstream.at(-1).id, result: { userAgent: 'codex/0.153.4' } });
  const event = { method: 'thread/status/changed', params: { threadId: 'test', status: { type: 'active', activeFlags: [] } } };
  f.relay.fromServer(event);
  assert.deepEqual(events, [event]);
  const call = f.relay.request('thread/read', { threadId: 'test' });
  f.relay.fromServer({ id: f.upstream.at(-1).id, result: { thread: { id: 'test' } } });
  assert.deepEqual(await call, { thread: { id: 'test' } });
  f.relay.close();
});

test('failed initialization cannot be bypassed by an initialized notification', async () => {
  const f = fixture();
  f.relay.fromDesktop({ id: 1, method: 'initialize', params: {} });
  f.relay.fromServer({ id: f.upstream.at(-1).id, error: { code: -32600, message: 'rejected' } });
  f.relay.fromDesktop({ method: 'initialized' });
  await assert.rejects(f.relay.request('thread/read', {}), /ready/i);
  f.relay.close();
});

function fixture(options = {}) {
  const upstream = [], downstream = [];
  const relay = api.createStdioRelay({
    toServer: message => upstream.push(message),
    toDesktop: message => downstream.push(message), ...options,
  });
  function initialize() {
    relay.fromDesktop({ id: 1, method: 'initialize', params: { clientInfo: { name: 'desktop' } } });
    relay.fromServer({ id: upstream.at(-1).id, result: {} });
    relay.fromDesktop({ method: 'initialized' });
  }
  return { relay, upstream, downstream, initialize };
}

test('preserves handshake and maps desktop request IDs without rewriting params', () => {
  const f = fixture(); f.initialize();
  assert.deepEqual(f.upstream[0].params, { clientInfo: { name: 'desktop' } });
  assert.deepEqual(f.downstream[0], { id: 1, result: {} });
  f.relay.fromDesktop({ id: 'q', method: 'thread/read', params: { threadId: 'user' } });
  f.relay.fromServer({ id: f.upstream.at(-1).id, result: { thread: { id: 'user' } } });
  assert.deepEqual(f.downstream.at(-1), { id: 'q', result: { thread: { id: 'user' } } });
  f.relay.close();
});

test('injected official RPC is invisible to desktop and cannot run before handshake', async () => {
  const f = fixture();
  await assert.rejects(f.relay.request('thread/read', {}), /ready/i);
  f.initialize();
  const call = f.relay.request('thread/read', { threadId: 'test' });
  const id = f.upstream.at(-1).id;
  f.relay.fromServer({ id, result: { thread: { id: 'test' } } });
  assert.deepEqual(await call, { thread: { id: 'test' } });
  assert.equal(f.downstream.length, 1);
  f.relay.close();
});

test('server requests and desktop approval responses pass through unchanged', async () => {
  const f = fixture(); f.initialize();
  const call = f.relay.request('thread/read', {});
  const sameId = f.upstream.at(-1).id;
  const approval = { id: sameId, method: 'item/commandExecution/requestApproval', params: {} };
  f.relay.fromServer(approval);
  assert.deepEqual(f.downstream.at(-1), approval);
  const answer = { id: sameId, result: { decision: 'decline' } };
  f.relay.fromDesktop(answer);
  assert.deepEqual(f.upstream.at(-1), answer);
  f.relay.fromServer({ id: sameId, result: {} });
  await call; f.relay.close();
});

test('observer errors never drop desktop notifications', () => {
  const f = fixture(); f.initialize();
  f.relay.subscribe(() => { throw Error('observer broken'); });
  const message = { method: 'thread/status/changed', params: { threadId: 'test', status: { type: 'idle' } } };
  f.relay.fromServer(message);
  assert.deepEqual(f.downstream.at(-1), message);
  f.relay.close();
});

test('timed-out observer responses remain private and close rejects pending work', async () => {
  const f = fixture({ timeoutMs: 10 }); f.initialize();
  const pending = f.relay.request('thread/read', {});
  const id = f.upstream.at(-1).id;
  await assert.rejects(pending, /timeout/i);
  f.relay.fromServer({ id, result: { secret: true } });
  assert.equal(f.downstream.length, 1);
  const second = f.relay.request('thread/read', {});
  f.relay.close();
  await assert.rejects(second, /closed/i);
});

test('observer cannot start turns or answer arbitrary RPCs', async () => {
  const f = fixture(); f.initialize();
  await assert.rejects(f.relay.request('turn/start', {}), /allowed/i);
  f.relay.close();
});

test('stopping observation drains Desktop replies but rejects internal work and hides late replies', async () => {
  const f = fixture(); f.initialize();
  const events = [];
  f.relay.subscribe(event => events.push(event));
  const pending = f.relay.request('thread/read', {});
  const internalId = f.upstream.at(-1).id;
  f.relay.fromDesktop({ id: 9, method: 'initialize', params: {} });
  const desktopId = f.upstream.at(-1).id;
  f.relay.stopObserving();
  await assert.rejects(pending, /stopped/i);
  f.relay.fromServer({ id: internalId, result: { private: true } });
  f.relay.fromServer({ id: desktopId, result: {} });
  const event = { method: 'turn/completed', params: { threadId: 'test' } };
  f.relay.fromServer(event);
  assert.deepEqual(f.downstream, [{ id: 1, result: {} }, { id: 9, result: {} }, event]);
  assert.deepEqual(events, []);
  await assert.rejects(f.relay.request('thread/read', {}), /stopped/i);
  f.relay.close();
});
