import test from 'node:test';
import assert from 'node:assert/strict';

import * as api from '../experimental/app-server-observer.mjs';
const sections = [
  { id: 'progress', name: 'In Progress' },
  { id: 'review', name: 'For Review' },
  { id: 'later', name: 'For Later' },
];
const task = (status, section = sections[1]) => ({
  id: 'test-thread', projectId: null, parentThreadId: null,
  section, status, archived: false,
});

test('experimental observer API exists', () => {
  assert.equal(typeof api.createObserver, 'function');
});

test('only explicit numeric loopback WebSocket endpoints are accepted', () => {
  assert.equal(api.localEndpoint('ws://127.0.0.1:9876/rpc'), 'ws://127.0.0.1:9876/rpc');
  for (const url of ['ws://example.com:9876', 'ws://0.0.0.0:9876', 'ws://localhost:9876',
    'ws://user:password@127.0.0.1:9876', 'ws://127.0.0.1:9876/?token=secret', 'file:///tmp/sock']) {
    assert.throws(() => api.localEndpoint(url));
  }
});

function fixture({ apply = false, thread = task({ type: 'active', activeFlags: [] }) } = {}) {
  let current = structuredClone(thread);
  const calls = [];
  const rpc = { async request(method, params) {
    calls.push({ method, params });
    if (method === 'threadSection/list') return { data: sections };
    if (method === 'thread/read') return { thread: structuredClone(current) };
    if (method === 'thread/section/move') {
      current.section = sections.find(s => s.id === params.sectionId);
      return {};
    }
    throw Error('Unexpected RPC: ' + method);
  } };
  const observer = api.createObserver(rpc, { threadIds: ['test-thread'], apply });
  return { observer, calls, set: value => { current = value; } };
}
const event = (threadId = 'test-thread') => ({ method: 'thread/status/changed', params: { threadId } });

test('dry run is default and reads state rather than trusting the event payload', async () => {
  const f = fixture();
  const result = await f.observer.handle(event());
  assert.equal(result.action, 'would-move');
  assert.equal(result.sectionId, 'progress');
  assert.equal(f.calls.some(c => c.method.endsWith('/move')), false);
});

test('allowlisted task moves active -> idle, repeated events are idempotent', async () => {
  const f = fixture({ apply: true });
  assert.equal((await f.observer.handle(event())).action, 'moved');
  assert.equal((await f.observer.handle(event())).action, 'unchanged');
  f.set(task({ type: 'idle' }, sections[0]));
  assert.equal((await f.observer.handle(event())).sectionId, 'review');
  assert.equal((await f.observer.handle(event())).action, 'unchanged');
  assert.equal(f.calls.filter(c => c.method.endsWith('/move')).length, 2);
});

test('other tasks, projects, child agents, protected sections and unloaded states fail closed', async () => {
  for (const thread of [task({ type: 'notLoaded' }), task({ type: 'idle' }),
    task({ type: 'active', activeFlags: [] }, sections[2]),
    task({ type: 'active', activeFlags: [] }, { id: 'pinned-id', name: 'Pinned' }),
    { ...task({ type: 'active', activeFlags: [] }), projectId: 'project' },
    { ...task({ type: 'active', activeFlags: [] }), parentThreadId: 'parent' },
    { ...task({ type: 'active', activeFlags: [] }), archived: true },
    { ...task({ type: 'active', activeFlags: [] }), id: 'wrong-id' },
    task({ type: 'active', activeFlags: ['unknown-flag'] })]) {
    const f = fixture({ apply: true, thread });
    assert.equal((await f.observer.handle(event())).action, 'skipped');
    assert.equal(f.calls.some(c => c.method.endsWith('/move')), false);
  }
  const f = fixture({ apply: true });
  assert.equal((await f.observer.handle(event('unlisted'))).action, 'skipped');
  assert.equal(f.calls.length, 0);
});

test('attention maps to review without treating arbitrary idle tasks as completed', async () => {
  const f = fixture({ apply: true, thread: task({ type: 'active', activeFlags: ['waitingOnApproval'] }, sections[0]) });
  assert.equal((await f.observer.handle(event())).sectionId, 'review');
});

test('duplicate sections and missing opt-in reject safely', async () => {
  assert.throws(() => api.createObserver({}, {}));
  const o = api.createObserver({ async request() { return { data: [...sections, sections[0]] }; } }, { threadIds: ['test-thread'], apply: true });
  await assert.rejects(o.handle(event()), /section/i);
});

test('final read protects a task moved to For Later while the event is processed', async () => {
  let reads = 0;
  const rpc = { async request(method) {
    if (method === 'threadSection/list') return { data: sections };
    if (method === 'thread/read') return { thread: task({ type: 'active', activeFlags: [] }, ++reads === 1 ? sections[1] : sections[2]) };
    assert.fail('Must not move after membership changes');
  } };
  const o = api.createObserver(rpc, { threadIds: ['test-thread'], apply: true });
  assert.equal((await o.handle(event())).action, 'skipped');
});

test('concurrent events serialize reads and writes', async () => {
  const f = fixture({ apply: true });
  await Promise.all([f.observer.handle(event()), f.observer.handle(event())]);
  assert.equal(f.calls.filter(c => c.method.endsWith('/move')).length, 1);
});

test('explicit exclusions override the test allowlist', async () => {
  const o = api.createObserver({ request() { assert.fail('Excluded task must not be read'); } }, {
    threadIds: ['organizer'], excludeThreadIds: ['organizer'], apply: true,
  });
  assert.equal((await o.handle(event('organizer'))).action, 'skipped');
});

test('missing section data is not interpreted as Tasks', async () => {
  const thread = task({ type: 'active', activeFlags: [] });
  delete thread.section;
  const f = fixture({ apply: true, thread });
  assert.equal((await f.observer.handle(event())).action, 'skipped');
});

test('a fast task can finish before the first read without losing its authoritative start event', async () => {
  const f = fixture({ apply: true, thread: task({ type: 'idle' }, null) });
  const result = await f.observer.handle({ method: 'thread/status/changed', params: {
    threadId: 'test-thread', status: { type: 'active', activeFlags: [] },
  } });
  assert.equal(result.action, 'moved');
  assert.equal(result.sectionId, 'review');
});

test('activity while protected does not authorize later idle classification', async () => {
  const f = fixture({ apply: true, thread: task({ type: 'idle' }, sections[2]) });
  await f.observer.handle({ method: 'turn/started', params: { threadId: 'test-thread' } });
  f.set(task({ type: 'idle' }, null));
  assert.equal((await f.observer.handle(event())).action, 'skipped');
});

test('explicit turn start preserves fast-turn completion and restart recovery is limited to In Progress', async () => {
  const fast = fixture({ apply: true, thread: task({ type: 'idle' }, null) });
  assert.equal((await fast.observer.handle({ method: 'turn/started', params: { threadId: 'test-thread' } })).sectionId, 'review');
  const recovery = fixture({ apply: true, thread: task({ type: 'idle' }, sections[0]) });
  assert.equal((await recovery.observer.handle(event())).sectionId, 'review');
});

test('approval and user-input attention resume correctly, then cancel/failure reaches review', async () => {
  for (const flag of ['waitingOnApproval', 'waitingOnUserInput']) {
    const f = fixture({ apply: true });
    await f.observer.handle(event());
    f.set(task({ type: 'active', activeFlags: [flag] }, sections[0]));
    assert.equal((await f.observer.handle(event())).sectionId, 'review');
    f.set(task({ type: 'active', activeFlags: [] }, sections[1]));
    assert.equal((await f.observer.handle(event())).sectionId, 'progress');
    f.set(task({ type: 'systemError' }, sections[0]));
    assert.equal((await f.observer.handle(event())).sectionId, 'review');
  }
});
