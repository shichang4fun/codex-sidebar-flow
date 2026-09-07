import test from 'node:test';
import assert from 'node:assert/strict';

import * as api from '../experimental/stdio-relay.mjs';
test('stdio relay API exists', () => assert.equal(typeof api.createStdioRelay, 'function'));

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
