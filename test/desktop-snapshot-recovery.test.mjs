import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopObserverManager } from '../experimental/desktop-observer-manager.mjs';

function fixture() {
  const timers = new Map(), moves = [];
  const state = { available: false, section: 'chats', type: 'active', project: false, parentPinned: false };
  const rpc = { async request(method, params) {
    assert.equal(method, 'mcpServer/tool/call');
    const thread = { id: 'task', kind: 'codex', hostId: 'local', projectId: state.project ? 'project' : null,
      status: { type: state.type, ...(state.type === 'active' ? { activeFlags: [] } : {}) } };
    let data;
    if (params.tool === 'list_threads') {
      data = { threads: state.section === 'pinned' ? [] : [thread],
        pinnedThreads: state.section === 'pinned' ? [thread] : [] };
      if (state.available) {
        data.sections = [['chats', 'Tasks'], ['progress', 'In Progress'], ['review', 'For Review'],
          ['later', 'For Later'], ['pinned', 'Pinned'], ['threads', 'Projects']]
          .map(([sectionId, name]) => ({ sectionId, name,
            itemKeys: sectionId === state.section ? ['codex:thread:local:task'] : [] }));
        if (state.project) data.sections.find(s => s.sectionId === (state.parentPinned ? 'pinned' : 'threads'))
          .itemKeys.push('codex:project:project');
      }
    } else if (params.tool === 'read_thread') data = { thread };
    else if (params.tool === 'move_thread_to_sidebar_section') {
      assert.equal(state.available, true, 'Unknown protection must never authorize a move');
      assert.equal(params.arguments.hostId, 'local');
      state.section = params.arguments.sectionId; moves.push(state.section); data = params.arguments;
    } else assert.fail(params.tool);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  } };
  const manager = createDesktopObserverManager(rpc, {
    readConfig: () => ({ version: 1, mode: 'all-local' }),
    setTimer(fn, delay) { timers.set(fn, delay); return fn; },
    clearTimer(fn) { timers.delete(fn); },
  });
  const start = { method: 'turn/started', params: { threadId: 'task', turn: { id: 'turn' } } };
  const complete = { method: 'turn/completed', params: { threadId: 'task', turn: { id: 'turn', status: 'completed' } } };
  return { manager, state, timers, moves, start, complete };
}

for (const project of [false, true]) test(`completion retains genuine start after unavailable protection (project=${project})`, async t => {
  const f = fixture(); t.after(() => f.manager.stop()); f.state.project = project;
  await assert.rejects(f.manager.handle(f.start));
  assert.deepEqual(f.moves, []);
  f.state.available = true; f.state.type = 'idle';
  const result = await f.manager.handle(f.complete);
  assert.equal(result.action, 'moved');
  assert.deepEqual(f.moves, ['review']);
  assert.equal(f.timers.size, 0, 'Completion consumes the existing bounded retry');
});

for (const protection of ['later', 'pinned', 'parent-pinned']) test(`retained start cannot bypass fresh ${protection} protection`, async t => {
  const f = fixture(); t.after(() => f.manager.stop());
  await assert.rejects(f.manager.handle(f.start));
  f.state.available = true; f.state.type = 'idle';
  if (protection === 'parent-pinned') { f.state.project = true; f.state.parentPinned = true; }
  else f.state.section = protection;
  await f.manager.handle(f.complete).catch(() => {});
  assert.deepEqual(f.moves, []);
  assert.equal(f.timers.size, 0);
});

test('unavailable protection uses the existing finite retry budget without retaining a second event store', async t => {
  const f = fixture(); t.after(() => f.manager.stop());
  await assert.rejects(f.manager.handle(f.start));
  const delays = [];
  while (f.timers.size) {
    assert.ok(delays.length < 5, 'Retry cannot run indefinitely');
    const [fn, delay] = f.timers.entries().next().value;
    f.timers.delete(fn); delays.push(delay); fn(); await f.manager.drain();
  }
  assert.deepEqual(delays, [250, 750, 2000, 5000]);
  assert.deepEqual(f.moves, []);
});
