import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopObserverManager } from '../experimental/desktop-observer-manager.mjs';

const active = () => ({ type: 'active', activeFlags: [] });
const changed = status => ({ method: 'thread/status/changed', params: { threadId: 'task', status } });
const turn = (method, id) => ({ method, params: { threadId: 'task', turn: { id,
  status: method === 'turn/started' ? 'inProgress' : 'completed' } } });

function fixture({ project = false } = {}) {
  const task = { id: 'task', kind: 'codex', hostId: 'local', projectId: project ? 'project' : null, status: active() };
  let section = 'chats', parent = 'threads';
  const calls = [], moves = [], timings = [], timers = [];
  let hold;
  const rpc = { async request(method, p) {
    assert.equal(method, 'mcpServer/tool/call');
    calls.push(p.tool);
    let value;
    if (p.tool === 'list_threads') value = { threads: [task], pinnedThreads: [], sections:
      [['chats', 'Tasks'], ['threads', 'Projects'], ['pinned', 'Pinned'],
        ['progress', 'In Progress'], ['review', 'For Review'], ['later', 'For Later']]
        .map(([sectionId, name]) => ({ sectionId, name, itemKeys: [
          ...(sectionId === section && !(project && section === 'chats') ? ['codex:thread:local:task'] : []),
          ...(project && sectionId === parent ? ['codex:project:project'] : []),
        ] })) };
    else if (p.tool === 'read_thread') value = { thread: task };
    else if (p.tool === 'move_thread_to_sidebar_section') {
      section = p.arguments.sectionId; moves.push(section); value = p.arguments;
    } else assert.fail(p.tool);
    // Capture the response before blocking, to reproduce stale RPCs already in flight.
    const response = { content: [{ type: 'text', text: JSON.stringify(value) }] };
    if (hold?.tool === p.tool && calls.filter(c => c === p.tool).length === hold.number) {
      hold.enter(); await hold.gate;
      if (hold.fail) throw Error('Simulated transport error');
    }
    return response;
  } };
  const manager = createDesktopObserverManager(rpc, {
    readConfig: () => ({ version: 1, mode: 'all-local' }), onTiming: r => timings.push(r),
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cancelled = true; },
  });
  return { task, calls, moves, manager, timings, timers,
    place: value => { section = value; }, pinProject: () => { parent = 'pinned'; },
    block(tool, number, fail = false) {
      let release, enter;
      const gate = new Promise(resolve => { release = resolve; });
      const entered = new Promise(resolve => { enter = resolve; });
      hold = { tool, number, enter, gate, fail };
      return { entered, release };
    },
  };
}

test('duplicate start notifications arriving during a slow read share one transaction', async () => {
  const f = fixture(), block = f.block('list_threads', 1);
  const first = f.manager.handle(turn('turn/started', 'one'));
  await block.entered;
  const duplicate = f.manager.handle(turn('turn/started', 'one'));
  block.release();
  await Promise.all([first, duplicate]);
  assert.deepEqual(f.moves, ['progress']);
  assert.equal(f.calls.filter(c => c === 'list_threads').length, 3);
  assert.equal(f.timings.length, 1);
});

test('first explicit turn identity supersedes an anonymous active transaction', async () => {
  const f = fixture(), block = f.block('list_threads', 1);
  const first = f.manager.handle(changed(active()));
  await block.entered;
  const started = f.manager.handle(turn('turn/started', 'one'));
  block.release(); const [old] = await Promise.all([first, started]);
  assert.equal(old.reason, 'superseded');
  assert.deepEqual(f.timings[0].rpcCounts, { list_threads: 1 });
  assert.deepEqual(f.moves, ['progress']);
});

for (const project of [false, true]) test(`completion cancels stale prewrite reads and preserves start evidence (project=${project})`, async () => {
  const f = fixture({ project }), block = f.block('read_thread', 3);
  const first = f.manager.handle(turn('turn/started', 'one'));
  await block.entered;
  f.task.status = { type: 'idle' };
  const done = f.manager.handle(turn('turn/completed', 'one'));
  block.release();
  const [old] = await Promise.all([first, done]);
  assert.deepEqual(f.moves, ['review'], 'Never dispatch the obsolete progress move');
  assert.equal(old.reason, 'superseded');
  assert.equal(f.timers.length, 0, 'Cancellation must not schedule an RPC-failure retry');
});

test('obsolete transaction stops after its first slow snapshot instead of issuing more reads', async () => {
  const f = fixture(), block = f.block('list_threads', 1);
  const first = f.manager.handle(turn('turn/started', 'one'));
  await block.entered;
  f.task.status = { type: 'idle' };
  const done = f.manager.handle(turn('turn/completed', 'one'));
  block.release(); await Promise.all([first, done]);
  assert.deepEqual(f.moves, ['review']);
  assert.deepEqual(f.timings[0].rpcCounts, { list_threads: 1 });
});

test('a different turn ID is never dropped even when its phase remains active', async () => {
  const f = fixture(), block = f.block('list_threads', 3);
  const first = f.manager.handle(turn('turn/started', 'one'));
  await block.entered;
  f.place('review');
  const next = f.manager.handle(turn('turn/started', 'two'));
  block.release(); await Promise.allSettled([first, next]);
  assert.deepEqual(f.moves, ['progress', 'progress']);
});

for (const status of [{ type: 'notLoaded' }, { type: 'active', activeFlags: ['waitingOnApproval'] },
  { type: 'active', activeFlags: ['waitingOnUserInput'] }, { type: 'systemError' }]) {
  test(`new ${JSON.stringify(status)} evidence invalidates an in-flight progress write`, async () => {
    const f = fixture(), block = f.block('read_thread', 3);
    const first = f.manager.handle(turn('turn/started', 'one'));
    await block.entered;
    f.task.status = status;
    const latest = f.manager.handle(changed(status));
    block.release(); await Promise.all([first, latest]);
    assert.ok(!f.moves.includes('progress'));
    assert.deepEqual(f.moves, status.type === 'notLoaded' ? [] : ['review']);
  });
}

test('fresh membership protection still rejects pinning during an in-flight duplicate', async () => {
  const f = fixture({ project: true }), block = f.block('list_threads', 1);
  const first = f.manager.handle(turn('turn/started', 'one'));
  await block.entered;
  f.pinProject();
  const duplicate = f.manager.handle(turn('turn/started', 'one'));
  block.release();
  const results = await Promise.allSettled([first, duplicate]);
  assert.ok(results.every(r => r.status === 'rejected'));
  assert.deepEqual(f.moves, []);
});

test('a superseded failing RPC is cancellation, not a stale-start retry', async () => {
  const f = fixture(), block = f.block('list_threads', 1, true);
  const first = f.manager.handle(turn('turn/started', 'one'));
  await block.entered;
  f.task.status = { type: 'idle' };
  const done = f.manager.handle(turn('turn/completed', 'one'));
  block.release(); const results = await Promise.allSettled([first, done]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[0].value.reason, 'superseded');
  assert.equal(f.timers.length, 0);
  assert.deepEqual(f.moves, ['review']);
});

test('active to approval to active never rejoins an obsolete transaction', async () => {
  const f = fixture(), block = f.block('read_thread', 3);
  const first = f.manager.handle(changed(active()));
  await block.entered;
  const approval = f.manager.handle(changed({ type: 'active', activeFlags: ['waitingOnApproval'] }));
  const resumed = f.manager.handle(changed(active()));
  block.release(); const [old] = await Promise.all([first, approval, resumed]);
  assert.equal(old.reason, 'superseded');
  assert.deepEqual(f.moves, ['progress']);
  assert.equal(f.timings.length, 2);
});

test('duplicates during a real transport failure share its single bounded retry', async () => {
  const f = fixture(), block = f.block('list_threads', 1, true);
  const first = f.manager.handle(turn('turn/started', 'one'));
  await block.entered;
  const duplicate = f.manager.handle(turn('turn/started', 'one'));
  block.release(); const results = await Promise.allSettled([first, duplicate]);
  assert.ok(results.every(r => r.status === 'rejected'));
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.length, 1);
  f.timers[0].fn(); await f.manager.drain();
  assert.deepEqual(f.moves, ['progress']);
});

for (const protectedSection of ['pinned', 'later']) {
  test(`new event successor preserves freshly changed ${protectedSection} membership`, async () => {
    const f = fixture(), block = f.block('list_threads', 1);
    const first = f.manager.handle(turn('turn/started', 'one'));
    await block.entered;
    f.place(protectedSection); f.task.status = { type: 'idle' };
    const done = f.manager.handle(turn('turn/completed', 'one'));
    block.release(); await Promise.all([first, done]);
    assert.deepEqual(f.moves, []);
  });
}

test('lifecycle successor replaces a superseded observer using another recovery context', async () => {
  const task = { id: 'task', kind: 'codex', hostId: 'local', projectId: null, status: active() };
  let section = 'chats', listCount = 0;
  let config = { version: 1, mode: 'all-local' };
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const manager = createDesktopObserverManager({ async request(method, p) {
    if (method === 'thread/loaded/list') return { data: ['recovery-context'] };
    assert.equal(method, 'mcpServer/tool/call');
    calls.push(p);
    let value;
    if (p.tool === 'list_threads') {
      value = { threads: [task], pinnedThreads: [], sections:
        [['chats', 'Tasks'], ['progress', 'In Progress'], ['review', 'For Review'], ['later', 'For Later']]
          .map(([sectionId, name]) => ({ sectionId, name,
            itemKeys: sectionId === section ? ['codex:thread:local:task'] : [] })) };
    } else if (p.tool === 'read_thread') value = { thread: task };
    else if (p.tool === 'move_thread_to_sidebar_section') {
      section = p.arguments.sectionId; value = p.arguments;
    } else assert.fail(p.tool);
    const response = { content: [{ type: 'text', text: JSON.stringify(value) }] };
    // First list discovers candidates; second list belongs to the target repair.
    if (p.tool === 'list_threads' && ++listCount === 2) { enter(); await gate; }
    return response;
  } }, { readConfig: () => config });
  const scan = manager.reconcile();
  await entered;
  config = { version: 1, mode: 'all-local', excludedThreadIds: ['recovery-context'] };
  const event = manager.handle(turn('turn/started', 'one'));
  release();
  await Promise.all([scan, event]);
  assert.equal(section, 'progress');
  assert.ok(calls.slice(0, 2).every(p => p.threadId === 'recovery-context'));
  assert.ok(calls.slice(2).length > 0);
  assert.ok(calls.slice(2).every(p => p.threadId === 'task'),
    'Lifecycle transactions must use their own task context, including after the recovery context is excluded');
  manager.stop();
});
