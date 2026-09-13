import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopObserverManager } from '../experimental/desktop-observer-manager.mjs';

function fixture({ project = false, unavailable = 0, managerOptions = {} } = {}) {
  const task = { id: 'new-task', kind: 'codex', hostId: 'local', projectId: project ? 'project' : null,
    status: { type: 'active', activeFlags: [] } };
  let section = project ? null : 'chats';
  const state = { visible: true, membership: true, parentSection: 'threads', enabled: true };
  const moves = [], timers = [], calls = [];
  const rpc = { async request(method, p) {
    calls.push({ method, p });
    if (state.beforeRequest) await state.beforeRequest();
    if (method === 'thread/loaded/list') return { data: [task.id] };
    assert.equal(method, 'mcpServer/tool/call');
    if (unavailable-- > 0) return { isError: true, content: [{ type: 'text', text: 'private error text' }] };
    const sections = [['chats', 'Tasks'], ['threads', 'Projects'], ['pinned', 'Pinned'],
      ['progress', 'In Progress'], ['review', 'For Review'], ['later', 'For Later']]
      .map(([sectionId, name]) => ({ sectionId, name, itemKeys: state.membership && sectionId === section ? [`codex:thread:local:${task.id}`] : [] }));
    if (project) sections.find(s => s.sectionId === state.parentSection).itemKeys.push('codex:project:project');
    let result;
    if (p.tool === 'list_threads') result = { threads: state.visible ? [task] : [], pinnedThreads: [], sections };
    else if (p.tool === 'read_thread') result = { thread: task };
    else if (p.tool === 'move_thread_to_sidebar_section') {
      section = p.arguments.sectionId; moves.push(section); result = p.arguments;
    } else assert.fail(p.tool);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } };
  const manager = createDesktopObserverManager(rpc, {
    readConfig: () => ({ version: 1, mode: state.enabled ? 'all-local' : 'disabled' }),
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: t => { t.cancelled = true; },
    ...managerOptions,
  });
  return { task, moves, timers, manager, calls, state,
    async retry() { const t = timers.find(t => !t.cancelled && !t.fired); assert.ok(t, 'Expected bounded startup retry'); t.fired = true; t.fn(); await manager.drain(); },
    event: method => ({ method, params: { threadId: task.id } }),
  };
}

test('coalesced short-turn start and completion need one fresh transaction, not a second unchanged query', async () => {
  const f = fixture();
  const start = f.manager.handle(f.event('turn/started'));
  f.task.status = { type: 'idle' };
  const done = f.manager.handle(f.event('turn/completed'));
  const results = await Promise.all([start, done]);
  assert.deepEqual(f.moves, ['review']);
  assert.ok(results.every(r => r.action === 'moved'));
  assert.equal(f.calls.filter(c => c.p?.tool === 'list_threads').length, 3);
});

test('transaction timing separates queue, native calls and readback without recording task content', async () => {
  let time = 0;
  const records = [];
  const f = fixture({ managerOptions: { now: () => time, onTiming: value => records.push(value) } });
  f.state.beforeRequest = () => { time += 10; };
  const event = f.event('turn/started'); event.params.secret = 'PRIVATE_PROMPT';
  const running = f.manager.handle(event);
  time = 100;
  await running;
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.threadId, f.task.id);
  assert.equal(r.queueMs, 100);
  assert.equal(r.executionMs, 80);
  assert.equal(r.moveAfterMs, 160);
  assert.equal(r.readbackMs, 20);
  assert.deepEqual(r.rpcCounts, { list_threads: 3, read_thread: 4, move_thread_to_sidebar_section: 1 });
  assert.deepEqual(r.rpcMs, { list_threads: 30, read_thread: 40, move_thread_to_sidebar_section: 10 });
  assert.equal(r.action, 'moved');
  assert.equal(JSON.stringify(records).includes('PRIVATE_PROMPT'), false);
});

test('coalesced terminal catches a start-to-idle race between reads instead of losing start evidence', async () => {
  const f = fixture();
  f.state.beforeRequest = () => {
    if (f.calls.filter(c => c.p?.tool === 'read_thread').length === 2) f.task.status = { type: 'idle' };
  };
  const start = f.manager.handle(f.event('turn/started'));
  const done = f.manager.handle(f.event('turn/completed'));
  await Promise.all([start, done]);
  assert.deepEqual(f.moves, ['review']);
});

test('a retained observer charges each later event to its own timing record', async () => {
  const records = [];
  const f = fixture({ managerOptions: { onTiming: r => records.push(r) } });
  await f.manager.handle(f.event('turn/started'));
  f.task.status = { type: 'idle' };
  await f.manager.handle(f.event('turn/completed'));
  assert.equal(records.length, 2);
  assert.notEqual(records[0].rpcCounts, records[1].rpcCounts);
  for (const record of records) assert.deepEqual(record.rpcCounts,
    { list_threads: 3, read_thread: 4, move_thread_to_sidebar_section: 1 });
});

test('completion arriving during successful progress readback remains queued and moves to review', async () => {
  const f = fixture();
  let release, entered;
  const inReadback = new Promise(resolve => { entered = resolve; });
  f.state.beforeRequest = () => {
    if (f.moves.length && !release) {
      entered(); return new Promise(resolve => { release = resolve; });
    }
  };
  const start = f.manager.handle(f.event('turn/started'));
  await inReadback;
  f.task.status = { type: 'idle' };
  const done = f.manager.handle(f.event('turn/completed'));
  release(); await Promise.all([start, done]);
  assert.deepEqual(f.moves, ['progress', 'review']);
});

test('timing callback failure cannot prevent movements; RPC failures have sanitized timing', async () => {
  const f = fixture({ managerOptions: { onTiming() { throw Error('logger broken'); } } });
  await f.manager.handle(f.event('turn/started'));
  assert.deepEqual(f.moves, ['progress']);
  const records = [];
  const g = fixture({ unavailable: 1, managerOptions: { onTiming: r => records.push(r) } });
  await assert.rejects(g.manager.handle(g.event('turn/started')));
  assert.equal(records.length, 1);
  assert.equal(records[0].action, 'error');
  assert.equal(JSON.stringify(records).includes('private error'), false);
  g.manager.stop();
});

test('new Project task is classified on start, attention, resume and completion', async () => {
  const f = fixture({ project: true });
  await f.manager.handle(f.event('turn/started'));
  assert.deepEqual(f.moves, ['progress']);
  f.task.status = { type: 'active', activeFlags: ['waitingOnUserInput'] };
  await f.manager.handle(f.event('thread/status/changed'));
  f.task.status = { type: 'active', activeFlags: [] };
  await f.manager.handle(f.event('turn/started'));
  f.task.status = { type: 'idle' };
  await f.manager.handle(f.event('turn/completed'));
  assert.deepEqual(f.moves, ['progress', 'review', 'progress', 'review']);
  assert.equal(f.task.projectId, 'project');
});

for (const missing of ['visible', 'membership']) test(`new task retries until ${missing} metadata is ready`, async () => {
  const f = fixture();
  f.state[missing] = false;
  await assert.rejects(f.manager.handle(f.event('turn/started')));
  f.state[missing] = true;
  await f.retry();
  assert.deepEqual(f.moves, ['progress']);
});

test('startup retry rechecks disabled policy and protected Project parents', async () => {
  for (const parentSection of ['pinned', 'later']) {
    const f = fixture({ project: true, unavailable: 1 });
    await assert.rejects(f.manager.handle(f.event('turn/started')));
    f.state.parentSection = parentSection;
    await f.retry();
    assert.deepEqual(f.moves, []);
  }
  const f = fixture({ unavailable: 1 });
  await assert.rejects(f.manager.handle(f.event('turn/started')));
  f.state.enabled = false;
  await f.retry();
  assert.equal(f.calls.length, 1);
});

test('compensation preserves pending startup evidence for a short task', async () => {
  const f = fixture({ unavailable: 1 });
  await assert.rejects(f.manager.handle(f.event('turn/started')));
  f.task.status = { type: 'idle' };
  const result = await f.manager.reconcile();
  assert.equal(result.errors, 0);
  assert.deepEqual(f.moves, ['review']);
});

test('events queued during a failing read consume its retry without replaying stale starts', async () => {
  const f = fixture({ unavailable: 1 });
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.state.beforeRequest = () => {
    f.state.beforeRequest = null;
    entered();
    return new Promise(resolve => { release = resolve; });
  };
  const first = f.manager.handle(f.event('turn/started')).catch(() => {});
  await started;
  const active = f.manager.handle({ method: 'thread/status/changed',
    params: { threadId: f.task.id, status: { type: 'active', activeFlags: [] } } });
  f.task.status = { type: 'idle' };
  const completed = f.manager.handle(f.event('turn/completed'));
  release();
  await Promise.all([first, active, completed]);
  assert.deepEqual(f.moves, ['review']);
  assert.equal(f.timers.filter(t => !t.cancelled && !t.fired).length, 0);
});

test('new non-Project task recovers initial native-tool unavailability without waiting for compensation', async () => {
  const f = fixture({ unavailable: 1 });
  await f.manager.handle(f.event('turn/started')).catch(() => {});
  await f.retry();
  assert.deepEqual(f.moves, ['progress']);
  assert.ok(f.timers[0].ms <= 500);
});

test('a short task retains real start evidence through startup failure and completion', async () => {
  const f = fixture({ unavailable: 2 });
  await f.manager.handle(f.event('turn/started')).catch(() => {});
  f.task.status = { type: 'idle' };
  await f.manager.handle(f.event('turn/completed')).catch(() => {});
  await f.retry();
  assert.deepEqual(f.moves, ['review']);
});

test('startup retries are bounded and stop() cancels pending work', async () => {
  const f = fixture({ unavailable: 100 });
  await f.manager.handle(f.event('turn/started')).catch(() => {});
  for (let n = 0; n < 4; n++) await f.retry();
  assert.equal(f.timers.filter(t => !t.cancelled && !t.fired).length, 0);
  assert.equal(f.calls.length, 5);
  const g = fixture({ unavailable: 100 });
  await g.manager.handle(g.event('turn/started')).catch(() => {});
  g.manager.stop();
  assert.ok(g.timers.every(t => t.cancelled));
});
