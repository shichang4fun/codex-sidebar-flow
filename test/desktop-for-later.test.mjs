import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopObserverManager } from '../experimental/desktop-observer-manager.mjs';
import { desktopMcpAdapter } from '../experimental/desktop-mcp-adapter.mjs';

const active = () => ({ type: 'active', activeFlags: [] });
function fixture({ projectId = null, status = active() } = {}) {
  const task = { id: 'later-task', kind: 'codex', hostId: 'local', projectId, status };
  const sections = [['chats', 'Tasks'], ['threads', 'Projects'], ['pinned', 'Pinned'],
    ['progress', 'In Progress'], ['review', 'For Review'], ['later', 'For Later'], ['other', 'Custom']]
    .map(([sectionId, name]) => ({ sectionId, name, itemKeys: [] }));
  const key = `codex:thread:local:${task.id}`;
  const section = id => sections.find(s => s.sectionId === id);
  const place = id => {
    for (const s of sections) s.itemKeys = s.itemKeys.filter(k => k !== key);
    section(id).itemKeys.push(key);
  };
  place('later');
  if (projectId) section('threads').itemKeys.push(`codex:project:${projectId}`);
  const moves = [], calls = [];
  const rpc = { async request(method, params) {
    if (method === 'thread/loaded/list') return { data: [task.id] };
    assert.equal(method, 'mcpServer/tool/call');
    assert.equal(params.threadId, task.id);
    assert.equal(params.server, 'codex_app');
    calls.push(params);
    let result;
    if (params.tool === 'list_threads') {
      const pinned = section('pinned').itemKeys.includes(key);
      result = { threads: pinned ? [] : [task], pinnedThreads: pinned ? [{ ...task, pinnedIndex: 1 }] : [], sections };
    } else if (params.tool === 'read_thread') result = { thread: task };
    else if (params.tool === 'move_thread_to_sidebar_section') {
      assert.deepEqual(params.arguments, { threadId: task.id, hostId: 'local', sectionId: params.arguments.sectionId });
      place(params.arguments.sectionId); moves.push(params.arguments.sectionId); result = params.arguments;
    } else assert.fail(params.tool);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } };
  const manager = createDesktopObserverManager(rpc, { readConfig: () => ({ version: 1, mode: 'all-local' }) });
  const start = () => manager.handle({ method: 'turn/started', params: { threadId: task.id } });
  return { task, sections, section, key, place, moves, calls, rpc, manager, start,
    adapter: desktopMcpAdapter(rpc, task.id) };
}

for (const projectId of [null, 'ordinary-project']) {
  test(`For Later start moves only the ${projectId ? 'Project child' : 'ordinary task'}, then completes normally`, async () => {
    const f = fixture({ projectId });
    const projectsBefore = f.section('threads').itemKeys.slice();
    assert.equal((await f.start()).sectionId, 'progress');
    await f.start();
    assert.deepEqual(f.moves, ['progress']);
    f.task.status = { type: 'idle' };
    assert.equal((await f.manager.handle({ method: 'turn/completed', params: { threadId: f.task.id } })).sectionId, 'review');
    assert.deepEqual(f.moves, ['progress', 'review']);
    assert.equal(f.task.projectId, projectId);
    assert.deepEqual(f.section('threads').itemKeys, projectsBefore);
  });
}

test('For Later ignores stale start hints when the authoritative task is not actively running', async () => {
  for (const status of [{ type: 'idle' }, { type: 'systemError' }, { type: 'notLoaded' },
    { type: 'active' }, { type: 'active', activeFlags: ['waitingOnApproval'] },
    { type: 'active', activeFlags: ['waitingOnUserInput'] }, { type: 'active', activeFlags: ['unknown'] }]) {
    const f = fixture({ status });
    assert.equal((await f.start()).action, 'skipped');
    assert.deepEqual(f.moves, []);
    assert.deepEqual(f.section('later').itemKeys, [f.key]);
  }
});

test('previous activity cannot move an idle task manually returned to For Later into review', async () => {
  const f = fixture();
  await f.start();
  f.place('later'); f.task.status = { type: 'idle' };
  await f.manager.handle({ method: 'turn/completed', params: { threadId: f.task.id } });
  assert.deepEqual(f.moves, ['progress']);
  assert.deepEqual(f.section('later').itemKeys, [f.key]);
});

test('direct adapter admits only For Later to In Progress with a fresh running state', async () => {
  const f = fixture();
  await f.adapter.request('thread/section/move', { threadId: f.task.id, sectionId: 'progress' });
  assert.deepEqual(f.moves, ['progress']);
  for (const status of [active(), { type: 'idle' }, { type: 'active', activeFlags: ['waitingOnApproval'] }]) {
    const blocked = fixture({ status });
    await assert.rejects(blocked.adapter.request('thread/section/move', { threadId: blocked.task.id, sectionId: 'review' }));
    assert.deepEqual(blocked.moves, []);
  }
});

test('For Later write rejects a terminal or attention transition at the final native read', async () => {
  for (const status of [{ type: 'idle' }, { type: 'active', activeFlags: ['waitingOnApproval'] }]) {
    const f = fixture(), request = f.rpc.request;
    let reads = 0;
    f.rpc.request = async (method, params) => {
      if (params?.tool === 'read_thread' && ++reads === 3) f.task.status = status;
      return request(method, params);
    };
    await assert.rejects(f.start(), /Task changed before move/);
    assert.deepEqual(f.moves, []);
  }
});

test('start exception never overrides protected or ambiguous Project ancestry', async () => {
  for (const parent of ['pinned', 'later', 'other', 'missing', 'ambiguous']) {
    const f = fixture({ projectId: 'protected-project' });
    const key = 'codex:project:protected-project';
    f.section('threads').itemKeys = parent === 'ambiguous' ? [key] : [];
    if (parent !== 'missing') f.section(parent === 'ambiguous' ? 'other' : parent).itemKeys.push(key);
    await assert.rejects(f.start(), /Protected or unknown Project/);
    assert.deepEqual(f.moves, []);
  }
});

test('start exception never overrides Pinned, custom or ambiguous direct membership', async () => {
  for (const source of ['pinned', 'other', 'ambiguous']) {
    const f = fixture();
    if (source === 'ambiguous') f.section('other').itemKeys.push(f.key);
    else f.place(source);
    if (source === 'ambiguous') await assert.rejects(f.start(), /Ambiguous task membership/);
    else if (source === 'pinned') await assert.rejects(f.start(), /Protected pinned task/);
    else assert.equal((await f.start()).action, 'skipped');
    assert.deepEqual(f.moves, []);
  }
});

test('For Later cannot bypass fresh parent protection before the write', async () => {
  const f = fixture({ projectId: 'project' }), request = f.rpc.request;
  let lists = 0;
  f.rpc.request = async (method, params) => {
    if (params?.tool === 'list_threads' && ++lists === 2) {
      f.section('threads').itemKeys = [];
      f.section('later').itemKeys.push('codex:project:project');
    }
    return request(method, params);
  };
  await assert.rejects(f.start(), /Protected or unknown Project/);
  assert.deepEqual(f.moves, []);
});

test('compensation repairs an active For Later task but never an idle or attention task there', async () => {
  const f = fixture();
  assert.equal((await f.manager.reconcile()).moved, 1);
  assert.equal((await f.manager.reconcile()).moved, 0);
  assert.deepEqual(f.moves, ['progress']);
  for (const status of [{ type: 'idle' }, { type: 'active', activeFlags: ['waitingOnUserInput'] }]) {
    const blocked = fixture({ status });
    assert.equal((await blocked.manager.reconcile()).moved, 0);
    assert.deepEqual(blocked.moves, []);
  }
});
