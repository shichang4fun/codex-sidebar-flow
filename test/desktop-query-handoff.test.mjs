import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import { createDesktopObserverManager } from '../experimental/desktop-observer-manager.mjs';
import { createStdioRelay } from '../experimental/stdio-relay.mjs';

const event = (method, id = 'task') => ({ method, params: { threadId: id,
  ...(method === 'thread/status/changed' ? { status: { type: 'active', activeFlags: [] } }
    : { turn: { id: 'turn', status: method === 'turn/completed' ? 'completed' : 'inProgress' } }) } });

// Real relay, manager and adapter; only the Desktop MCP response boundary is fake.
function fixture(t, { holdTool = 'list_threads', holdNumber = 1, project = false } = {}) {
  const state = { section: 'chats', parentPinned: false, status: { type: 'active', activeFlags: [] } };
  const wire = [], requests = [], moves = [], timings = [], timers = new Map();
  let held;
  const relay = createStdioRelay({ toDesktop() {}, toServer(message) {
    if (message.method === 'initialize') return queueMicrotask(() => relay.fromServer({ id: message.id, result: {} }));
    wire.push(message);
    const { tool, arguments: args } = message.params;
    const task = { id: args.threadId ?? 'task', kind: 'codex', hostId: 'local', projectId: project ? 'project' : null, status: state.status };
    let value;
    if (tool === 'list_threads') value = { threads: [task], pinnedThreads: [], sections:
      [['chats', 'Tasks'], ['threads', 'Projects'], ['progress', 'In Progress'], ['review', 'For Review'], ['pinned', 'Pinned'], ['later', 'For Later']]
        .map(([sectionId, name]) => ({ sectionId, name, itemKeys: [
          ...(sectionId === state.section && !(project && sectionId === 'chats') ? ['codex:thread:local:task'] : []),
          ...(project && sectionId === (state.parentPinned ? 'pinned' : 'threads') ? ['codex:project:project'] : []),
        ] })) };
    else if (tool === 'read_thread') value = { thread: task };
    else if (tool === 'move_thread_to_sidebar_section') {
      state.section = args.sectionId; moves.push(args.sectionId); value = args;
    } else assert.fail(tool);
    // Capture before the hold: a shared unresolved read may contain old data.
    const response = { id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } };
    if (tool === holdTool && wire.filter(x => x.params.tool === tool).length === holdNumber) held = response;
    else queueMicrotask(() => relay.fromServer(response));
  } });
  relay.fromDesktop({ id: 1, method: 'initialize', params: {} });
  const manager = createDesktopObserverManager({ request(method, params) {
    requests.push(params); return relay.request(method, params);
  } }, { readConfig: () => ({ version: 1, mode: 'all-local' }), onTiming: x => timings.push(x),
    setTimer(fn, ms) { timers.set(fn, ms); return fn; }, clearTimer(fn) { timers.delete(fn); } });
  t.after(() => { manager.stop(); relay.close(); });
  return { manager, state, wire, requests, moves, timings, timers,
    release(fail = false) { assert.ok(held); relay.fromServer(fail ? { id: held.id, error: { code: -32603 } } : held); held = null; } };
}

test('superseded read yields immediately and successor joins only the unresolved same-context list', async t => {
  const f = fixture(t); await nextTick();
  let oldFinished = false;
  const old = f.manager.handle(event('thread/status/changed')).then(r => { oldFinished = true; return r; });
  await nextTick();
  const next = f.manager.handle(event('turn/started'));
  await nextTick();
  assert.equal(oldFinished, true, 'Obsolete work must not wait for the slow response');
  assert.equal(f.requests.length, 2, 'Successor has its own guarded request');
  assert.equal(f.wire.length, 1, 'Relay shares the unresolved wire read, not a completed snapshot');
  f.release();
  assert.equal((await old).reason, 'superseded');
  assert.equal((await next).action, 'moved');
  assert.deepEqual(f.moves, ['progress']);
  assert.equal(f.wire.filter(x => x.params.tool === 'list_threads').length, 3, 'Fresh prewrite and postwrite lists remain');
  assert.equal(f.timings[0].rpcCounts.list_threads, 1);
  assert.equal(f.timings[1].rpcCounts.list_threads, 3);
});

test('late failure of a cancelled read cannot retry an obsolete start or reject unhandled', async t => {
  const f = fixture(t); await nextTick();
  let oldFinished = false;
  const old = f.manager.handle(event('thread/status/changed')).then(r => { oldFinished = true; return r; });
  await nextTick();
  const next = f.manager.handle(event('turn/started'));
  const rejected = assert.rejects(next, /DESKTOP_MCP_UNAVAILABLE/);
  rejected.catch(() => {}); // Keep cleanup after a failed assertion handled.
  await nextTick();
  assert.equal(oldFinished, true);
  f.release(true);
  assert.equal((await old).reason, 'superseded'); await rejected;
  assert.deepEqual([...f.timers.values()], [250], 'Only current work schedules a bounded retry');
  assert.deepEqual(f.moves, []);
});

for (const fail of [false, true]) test(`successor finishes before stale target read returns (late failure=${fail})`, async t => {
  const f = fixture(t, { holdTool: 'read_thread' }); await nextTick();
  const old = f.manager.handle(event('turn/started')); await nextTick();
  f.state.status = { type: 'idle' };
  let finished = false;
  const next = f.manager.handle(event('turn/completed')).then(r => { finished = true; return r; });
  await nextTick();
  assert.equal(finished, true);
  assert.equal((await old).reason, 'superseded');
  assert.equal((await next).action, 'moved');
  assert.deepEqual(f.moves, ['review']);
  const before = JSON.stringify({ timings: f.timings, calls: f.requests });
  f.release(fail); await nextTick();
  assert.equal(JSON.stringify({ timings: f.timings, calls: f.requests }), before, 'Late replies cannot change published timings or issue calls');
  assert.equal(f.timers.size, 0);
});

for (const hold of [{ holdTool: 'move_thread_to_sidebar_section', holdNumber: 1 },
  { holdTool: 'list_threads', holdNumber: 3 }]) test(`dispatched write drains ${hold.holdTool} before successor runs`, async t => {
  const f = fixture(t, hold); await nextTick();
  const old = f.manager.handle(event('turn/started')); await nextTick();
  const count = f.requests.length;
  f.state.status = { type: 'idle' };
  let finished = false;
  const next = f.manager.handle(event('turn/completed')).then(r => { finished = true; return r; });
  await nextTick();
  assert.equal(finished, false);
  assert.equal(f.requests.length, count, 'No successor call overlaps a write/readback');
  f.release(); await Promise.all([old, next]);
  assert.deepEqual(f.moves, ['progress', 'review']);
});

for (const protection of ['pinned', 'parent-pinned', 'later-idle']) test(`fresh guard rejects ${protection} after sharing an older initial list`, async t => {
  const f = fixture(t, { project: protection === 'parent-pinned' }); await nextTick();
  const old = f.manager.handle(event('thread/status/changed')); await nextTick();
  const next = f.manager.handle(event('turn/started'));
  const settled = Promise.allSettled([old, next]);
  await nextTick();
  assert.equal(f.requests.length, 2); assert.equal(f.wire.length, 1);
  if (protection === 'parent-pinned') f.state.parentPinned = true;
  else f.state.section = protection === 'pinned' ? 'pinned' : 'later';
  if (protection === 'later-idle') f.state.status = { type: 'idle' };
  f.release(); await settled;
  assert.deepEqual(f.moves, []);
  assert.equal(f.timers.size, 0);
});
