import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopMcpAdapter } from '../experimental/desktop-mcp-adapter.mjs';
import { createObserver } from '../experimental/app-server-observer.mjs';
import { validateProxyConfig } from '../experimental/desktop-proxy-config.mjs';
import { createDesktopObserverManager } from '../experimental/desktop-observer-manager.mjs';

const sections = {
  inProgress: { desktopId: '10000000-0000-4000-8000-000000000001', localId: '20000000-0000-4000-8000-000000000001' },
  forReview: { desktopId: '10000000-0000-4000-8000-000000000002', localId: '20000000-0000-4000-8000-000000000002' },
};
const names = { inProgress: 'In Progress', forReview: 'For Review' };
const pinnedId = '01984de2-8f74-7c91-a3b2-5c5e937cf318';
const laterId = '20000000-0000-4000-8000-000000000003';
function fixture({ sourceSection = 'custom', status = { type: 'active', activeFlags: [] }, onCall = () => {}, activeFastPath = false, forLaterStart = null } = {}) {
  const calls = [], moves = [];
  const state = { archived: false, mappingValid: true, recordMove: true, thread: {
    id: 'task', cwd: '/fixture', source: 'appServer', parentThreadId: null, ephemeral: false,
    projectId: 'project', section: { id: sourceSection, name: sourceSection === laterId ? 'For Later' : sourceSection }, sectionEnteredAt: 100, status,
  } };
  const rpc = { async request(method, params = {}) {
    calls.push({ method, params }); onCall({ method, params, state, calls });
    if (method === 'threadSection/list' && state.sectionPages) return state.sectionPages[params.cursor ?? 'first'];
    if (method === 'threadSection/list') return { data: state.mappingValid ? [
      ...Object.entries(sections).map(([key, s]) => ({ id: s.localId, name: names[key] })),
      { id: laterId, name: 'For Later' },
      ...state.missingPinnedSection ? [] : [{ id: pinnedId, name: 'Pinned' }],
    ] : [], nextCursor: null };
    if (method === 'thread/loaded/list') return { data: ['task'], nextCursor: null };
    if (method === 'thread/read') return { thread: structuredClone(state.thread) };
    if (method === 'thread/list') {
      assert.equal(params.archived, false); assert.equal(params.useStateDbOnly, true);
      if (params.cwd && state.archivePages) return state.archivePages[params.cursor ?? 'first'];
      if (!params.cwd && state.recoveryPages) return state.recoveryPages[params.cursor ?? 'first'];
      return { data: state.archived || state.listVisible === false ? [] : [structuredClone(state.thread)], nextCursor: null };
    }
    assert.equal(method, 'mcpServer/tool/call');
    assert.equal(params.tool, 'move_thread_to_sidebar_section', 'Never query the global Desktop list');
    assert.equal(params.threadId, 'task'); assert.equal(params.arguments.hostId, 'local');
    const s = Object.entries(sections).find(([, s]) => s.desktopId === params.arguments.sectionId);
    assert.ok(s); moves.push(params.arguments);
    if (state.recordMove) state.thread.section = { id: s[1].localId, name: names[s[0]] };
    return { content: [{ type: 'text', text: JSON.stringify(params.arguments) }] };
  } };
  const adapter = desktopMcpAdapter(rpc, 'task', { forceStatusSections: sections, activeFastPath, forLaterStart });
  const observer = createObserver(adapter, { threadIds: ['task'], apply: true, forceStatus: true, allowProjectTasks: true });
  return { rpc, adapter, observer, state, calls, moves };
}

const newStart = (startedAt = 101) => ({ method: 'turn/started', params: {
  threadId: 'task', turn: { id: 'new-turn', startedAt },
} });
function laterManager(t, f, options = {}) {
  const manager = createDesktopObserverManager(f.rpc, {
    readConfig: () => ({ version: 1, mode: 'all-local', forceStatusSections: sections }), ...options,
  });
  t.after(() => manager.stop());
  return manager;
}

for (const status of [{ type: 'idle' }, { type: 'systemError' },
  { type: 'active', activeFlags: [] }, { type: 'active', activeFlags: ['waitingOnApproval'] }]) {
  test(`For Later survives compensation for ${JSON.stringify(status)}`, async t => {
    const f = fixture({ sourceSection: laterId, status });
    const manager = laterManager(t, f);
    assert.equal((await manager.reconcile()).moved, 0);
    assert.equal(f.moves.length, 0);
    assert.equal(f.state.thread.section.id, laterId);
  });
}

for (const message of [
  { method: 'thread/status/changed', params: { threadId: 'task', status: { type: 'active', activeFlags: [] } } },
  { method: 'thread/started', params: { thread: { id: 'task', status: { type: 'active', activeFlags: [] } } } },
  { method: 'turn/completed', params: { threadId: 'task', turn: { id: 'old-turn', status: 'completed' } } },
  newStart(99), newStart(100), newStart(null), newStart(NaN), newStart(-1),
]) test(`For Later rejects non-subsequent start evidence ${JSON.stringify(message)}`, async t => {
  const f = fixture({ sourceSection: laterId });
  assert.equal((await laterManager(t, f).handle(message)).action, 'skipped');
  assert.equal(f.moves.length, 0);
});

for (const entered of [null, undefined, NaN, -1]) test(`For Later needs authoritative placement time ${entered}`, async t => {
  const f = fixture({ sourceSection: laterId }); f.state.thread.sectionEnteredAt = entered;
  assert.equal((await laterManager(t, f).handle(newStart())).action, 'skipped');
  assert.equal(f.moves.length, 0);
});

test('For Later leaves on a subsequent turn then completes into review', async t => {
  const f = fixture({ sourceSection: laterId }); const manager = laterManager(t, f);
  assert.equal((await manager.handle(newStart())).action, 'moved');
  assert.equal(f.state.thread.section.id, sections.inProgress.localId);
  f.state.thread.status = { type: 'idle' };
  await manager.handle({ method: 'turn/completed', params: { threadId: 'task', turn: { id: 'new-turn', status: 'completed' } } });
  assert.equal(f.state.thread.section.id, sections.forReview.localId);
  assert.equal(f.state.thread.projectId, 'project');
});

test('manual deferral during a running turn survives its duplicate start and completion', async t => {
  const f = fixture(); const manager = laterManager(t, f);
  await manager.handle(newStart());
  f.state.thread.section = { id: laterId, name: 'For Later' }; f.state.thread.sectionEnteredAt = 102;
  assert.equal((await manager.handle(newStart())).action, 'skipped');
  f.state.thread.status = { type: 'idle' };
  await manager.handle({ method: 'turn/completed', params: { threadId: 'task', turn: { id: 'new-turn', status: 'completed' } } });
  await manager.reconcile();
  assert.equal(f.moves.length, 1); assert.equal(f.state.thread.section.id, laterId);
});

test('manual For Later before final native write revokes the old start', async t => {
  const f = fixture({ onCall({ method, state, calls }) {
    if (method === 'thread/read' && calls.filter(c => c.method === method).length === 3) {
      state.thread.section = { id: laterId, name: 'For Later' }; state.thread.sectionEnteredAt = 102;
    }
  } });
  assert.equal((await laterManager(t, f).handle(newStart())).action, 'skipped');
  assert.equal(f.moves.length, 0);
});

test('a queued start superseded by completion cannot release For Later', async t => {
  const f = fixture({ sourceSection: laterId }); const manager = laterManager(t, f);
  const a = manager.handle(newStart()); f.state.thread.status = { type: 'idle' };
  const b = manager.handle({ method: 'turn/completed', params: { threadId: 'task', turn: { id: 'new-turn', status: 'completed' } } });
  await Promise.all([a, b]); assert.equal(f.moves.length, 0);
});

test('For Later protection survives manager restart with no retained turn history', async t => {
  const f = fixture({ sourceSection: laterId }); f.state.thread.sectionEnteredAt = 102;
  const old = laterManager(t, f); old.stop();
  const restarted = laterManager(t, f);
  await restarted.reconcile(); await restarted.handle(newStart());
  assert.equal(f.moves.length, 0);
});

test('For Later ID is protected even if exact read omits the section name', async t => {
  const f = fixture({ sourceSection: laterId }); delete f.state.thread.section.name;
  assert.equal((await laterManager(t, f).reconcile()).moved, 0);
  assert.equal(f.moves.length, 0);
});

test('For Later name is protected when the listing has not exposed its ID', async t => {
  const f = fixture({ sourceSection: laterId }); f.state.thread.section.id = 'new-later';
  assert.equal((await laterManager(t, f).reconcile()).moved, 0);
  assert.equal(f.moves.length, 0);
});

test('latest active status cannot borrow a coalesced turn start to unlock For Later', async t => {
  const f = fixture({ sourceSection: laterId }); const manager = laterManager(t, f);
  const start = manager.handle(newStart());
  const active = manager.handle({ method: 'thread/status/changed', params: {
    threadId: 'task', status: { type: 'active', activeFlags: [] },
  } });
  await Promise.all([start, active]); assert.equal(f.moves.length, 0);
});

for (const status of [{ type: 'idle' }, { type: 'active', activeFlags: ['waitingOnUserInput'] }]) {
  test(`subsequent start cannot release an already terminal or waiting For Later task ${JSON.stringify(status)}`, async t => {
    const f = fixture({ sourceSection: laterId, status });
    assert.equal((await laterManager(t, f).handle(newStart())).action, 'skipped');
    assert.equal(f.moves.length, 0);
  });
}

test('a subsequent start does not override direct Pinned', async t => {
  const f = fixture({ sourceSection: pinnedId });
  await assert.rejects(laterManager(t, f).handle(newStart()), /Pinned/);
  assert.equal(f.moves.length, 0);
});

test('For Later needs valid explicit turn identity', async t => {
  const f = fixture({ sourceSection: laterId }); const start = newStart(); start.params.turn.id = '';
  assert.equal((await laterManager(t, f).handle(start)).action, 'skipped');
  assert.equal(f.moves.length, 0);
});

test('force section mapping is explicit and validated in configuration', () => {
  const base = { version: 1, mode: 'all-local' };
  assert.deepEqual(validateProxyConfig({ ...base, forceStatusSections: sections }).forceStatusSections, sections);
  for (const bad of [true, {}, { inProgress: sections.inProgress },
    { ...sections, forReview: sections.inProgress }, { ...sections, inProgress: { desktopId: 'pinned', localId: 'bad' } },
    { ...sections, inProgress: { ...sections.inProgress, localId: pinnedId } }]) {
    assert.throws(() => validateProxyConfig({ ...base, forceStatusSections: bad }));
  }
});

test('local destination validation reads all section pages', async () => {
  const f = fixture(); f.state.sectionPages = {
    first: { data: [{ id: pinnedId, name: 'Pinned' }], nextCursor: 'destinations' },
    destinations: { data: Object.entries(sections).map(([key, s]) => ({ id: s.localId, name: names[key] })), nextCursor: null },
  };
  assert.equal((await f.observer.reconcile('task')).action, 'moved');
});

test('hot-switching a full default observer cache does not reject new force tasks', async t => {
  let config = { version: 1, mode: 'all-local' };
  const f = fixture({ status: { type: 'idle' }, sourceSection: sections.forReview.localId });
  const rpc = { async request(method, params = {}) {
    if (config.forceStatusSections) return f.rpc.request(method, params);
    assert.equal(method, 'mcpServer/tool/call');
    const id = params.threadId;
    const thread = { id, hostId: 'local', kind: 'codex', projectId: null, status: { type: 'active', activeFlags: [] } };
    const value = params.tool === 'read_thread' ? { thread } : {
      threads: [thread], pinnedThreads: [], sections: [
        { sectionId: 'progress', name: 'In Progress', itemKeys: [`codex:thread:local:${id}`] },
        { sectionId: 'review', name: 'For Review', itemKeys: [] },
        { sectionId: 'later', name: 'For Later', itemKeys: [] },
      ],
    };
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  } };
  const manager = createDesktopObserverManager(rpc, { readConfig: () => config });
  t.after(() => manager.stop());
  for (let i = 0; i < 256; i++) assert.equal((await manager.handle({ method: 'thread/status/changed',
    params: { threadId: `old-${i}`, status: { type: 'active', activeFlags: [] } } })).action, 'unchanged');
  config = { ...config, forceStatusSections: sections };
  assert.equal((await manager.handle({ method: 'thread/status/changed', params: { threadId: 'task', status: { type: 'idle' } } })).action, 'unchanged');
});

test('nonarchived proof follows local pages instead of rejecting older tasks', async () => {
  const f = fixture(); f.state.archivePages = {
    first: { data: [], nextCursor: 'older' }, older: { data: [f.state.thread], nextCursor: null },
  };
  assert.equal((await f.observer.reconcile('task')).action, 'moved');
});

test('malformed or repeating local pagination cannot authorize a move', async () => {
  const f = fixture(); f.state.archivePages = { first: { data: [], nextCursor: 'first' } };
  await assert.rejects(f.observer.reconcile('task'));
  assert.equal(f.moves.length, 0);
});

test('force status notifications do not exhaust retained observer slots', async t => {
  const rpc = { async request(method, params = {}) {
    if (method === 'threadSection/list') return { data: [
      { id: pinnedId, name: 'Pinned' }, ...Object.entries(sections).map(([key, s]) => ({ id: s.localId, name: names[key] })),
    ] };
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: params.threadId, source: 'appServer',
      parentThreadId: null, ephemeral: false, projectId: null, section: { id: sections.forReview.localId }, status: { type: 'idle' } } };
    assert.equal(method, 'thread/list'); return { data: [{ id: params.cwd }], nextCursor: null };
  } };
  const manager = createDesktopObserverManager(rpc, { readConfig: () => ({ version: 1, mode: 'all-local', forceStatusSections: sections }) });
  t.after(() => manager.stop());
  for (let i = 0; i < 270; i++) assert.equal((await manager.handle({ method: 'thread/status/changed',
    params: { threadId: `task-${i}`, status: { type: 'idle' } } })).action, 'unchanged');
});

for (const sourceSection of ['custom', 'progress', 'review']) {
  test(`force active task out of ${sourceSection} using local reads only`, async () => {
    const f = fixture({ sourceSection });
    const result = await f.observer.reconcile('task');
    assert.equal(result.action, 'moved');
    assert.equal(f.state.thread.section.id, sections.inProgress.localId);
    assert.equal(f.state.thread.projectId, 'project');
    assert.equal(f.moves.length, 1);
    assert.equal((await f.observer.reconcile('task')).action, 'unchanged');
    assert.equal(f.moves.length, 1);
  });
}

for (const when of ['initial', 'before-write']) test(`Pinned is protected: ${when}`, async () => {
  const f = fixture({ sourceSection: when === 'initial' ? pinnedId : 'custom', onCall({ method, state, calls }) {
    if (when === 'before-write' && method === 'thread/read' && calls.filter(c => c.method === method).length === 3)
      state.thread.section = { id: pinnedId, name: 'Pinned' };
  } });
  await assert.rejects(f.observer.reconcile('task'), /Pinned/);
  assert.equal(f.moves.length, 0);
});

test('an unsupported local pinned projection fails closed', async () => {
  const f = fixture(); f.state.missingPinnedSection = true;
  await assert.rejects(f.observer.reconcile('task'));
  assert.equal(f.moves.length, 0);
});

for (const status of [{ type: 'idle' }, { type: 'systemError' },
  { type: 'active', activeFlags: ['waitingOnApproval'] }, { type: 'active', activeFlags: ['waitingOnUserInput'] }]) {
  test(`force ${JSON.stringify(status)} into review without prior start evidence`, async () => {
    const f = fixture({ status, sourceSection: 'custom' });
    assert.equal((await f.observer.reconcile('task')).action, 'moved');
    assert.equal(f.state.thread.section.id, sections.forReview.localId);
  });
}

for (const status of [{ type: 'notLoaded' }, { type: 'active' }, { type: 'active', activeFlags: ['unknown'] }]) {
  test(`unknown runtime status does not authorize movement: ${JSON.stringify(status)}`, async () => {
    const f = fixture({ status });
    assert.equal((await f.observer.reconcile('task')).action, 'skipped'); assert.equal(f.moves.length, 0);
  });
}

for (const field of ['archived', 'subagent', 'ephemeral', 'wrong-id']) {
  test(`force mode still rejects ${field}`, async () => {
    const f = fixture();
    if (field === 'archived') f.state.archived = true;
    if (field === 'subagent') f.state.thread.source = { subAgent: 'review' };
    if (field === 'ephemeral') f.state.thread.ephemeral = true;
    if (field === 'wrong-id') f.state.thread.id = 'other';
    await assert.rejects(f.observer.reconcile('task')); assert.equal(f.moves.length, 0);
  });
}

test('force mode validates destinations and observes a fresh status adjacent to write', async () => {
  const f = fixture({ onCall({ method, state, calls }) {
    if (method === 'thread/read' && calls.filter(c => c.method === method).length === 3) state.thread.status = { type: 'idle' };
  } });
  await assert.rejects(f.observer.reconcile('task')); assert.equal(f.moves.length, 0);
  const g = fixture(); g.state.mappingValid = false;
  await assert.rejects(g.observer.reconcile('task')); assert.equal(g.moves.length, 0);
});

test('force mode requires real raw section readback instead of trusting a native move response', async () => {
  const f = fixture(); f.state.recordMove = false;
  await assert.rejects(f.observer.reconcile('task')); assert.equal(f.moves.length, 1);
});

test('force adapter cannot address another task or call an unsupported method', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.request('thread/read', { threadId: 'other' }));
  await assert.rejects(f.adapter.request('turn/start', { threadId: 'task' }));
  assert.equal(f.calls.length, 0);
});

test('manager activates force policy, measures local reads and never enumerates the global Desktop list', async t => {
  const f = fixture(), timings = [];
  const manager = createDesktopObserverManager(f.rpc, { readConfig: () => ({ version: 1, mode: 'all-local', forceStatusSections: sections }),
    onTiming: r => timings.push(r) });
  t.after(() => manager.stop());
  assert.equal((await manager.handle({ method: 'turn/started', params: { threadId: 'task', turn: { id: 'turn' } } })).action, 'moved');
  assert.ok(timings[0].rpcCounts['thread/read'] > 0);
  assert.equal(timings[0].rpcCounts['thread/list'], undefined);
  assert.equal(timings[0].rpcCounts.list_threads, undefined);
});

test('force recovery walks local pages and ignores global-list discovery', async t => {
  const f = fixture(); f.state.recoveryPages = {
    first: { data: [], nextCursor: 'next' }, next: { data: [f.state.thread], nextCursor: null },
  };
  const manager = createDesktopObserverManager(f.rpc, { readConfig: () => ({ version: 1, mode: 'all-local', forceStatusSections: sections }) });
  t.after(() => manager.stop());
  assert.equal((await manager.reconcile()).checked, 0);
  assert.equal((await manager.reconcile()).moved, 1);
  const calls = f.calls.filter(c => c.method === 'thread/list' && !c.params.cwd);
  assert.equal(calls[1].params.cursor, 'next');
});

test('configuration changes during a force transaction cannot dispatch its old destination', async t => {
  let config = { version: 1, mode: 'all-local', forceStatusSections: sections };
  const f = fixture({ onCall({ method }) { if (method === 'thread/read') config = { version: 1, mode: 'all-local' }; } });
  const manager = createDesktopObserverManager(f.rpc, { readConfig: () => config });
  t.after(() => manager.stop());
  await assert.rejects(manager.handle({ method: 'turn/started', params: { threadId: 'task', turn: { id: 'turn' } } }));
  assert.equal(f.moves.length, 0);
});

function startupFixture(t, options = {}) {
  // Retry fallback: a start may arrive before even its active metadata is readable.
  const f = fixture({ status: { type: 'notLoaded' }, ...options }), timers = new Map();
  f.state.listVisible = false;
  const manager = createDesktopObserverManager(f.rpc, {
    readConfig: () => ({ version: 1, mode: 'all-local', forceStatusSections: sections }),
    setTimer(fn, delay) { timers.set(fn, delay); return fn; },
    clearTimer(fn) { timers.delete(fn); },
  });
  t.after(() => manager.stop());
  const start = { method: 'turn/started', params: { threadId: 'task', turn: { id: 'turn' } } };
  async function retry() {
    assert.equal(timers.size, 1, 'A missing local row must retain one bounded retry');
    const [fn, delay] = timers.entries().next().value;
    timers.delete(fn); fn(); await manager.drain();
    return delay;
  }
  return { ...f, manager, timers, start, retry };
}

for (const project of [null, 'project']) test(`new task retries unavailable runtime metadata (project=${project})`, async t => {
  const f = startupFixture(t); f.state.thread.projectId = project;
  await assert.rejects(f.manager.handle(f.start), { code: 'TASK_NOT_VISIBLE' });
  assert.equal(f.moves.length, 0);
  f.state.listVisible = true;
  f.state.thread.status = { type: 'active', activeFlags: [] };
  assert.equal(await f.retry(), 250);
  assert.equal(f.moves.length, 1);
  assert.equal(f.moves[0].sectionId, sections.inProgress.desktopId);
  assert.equal(f.state.thread.projectId, project);
  assert.equal(f.timers.size, 0);
});

test('visibility retry reads completion instead of replaying an obsolete active state', async t => {
  const f = startupFixture(t);
  await assert.rejects(f.manager.handle(f.start), { code: 'TASK_NOT_VISIBLE' });
  f.state.listVisible = true; f.state.thread.status = { type: 'idle' };
  await f.retry();
  assert.deepEqual(f.moves.map(m => m.sectionId), [sections.forReview.desktopId]);
});

test('completion consumes a pending visibility retry without a second move', async t => {
  const f = startupFixture(t);
  await assert.rejects(f.manager.handle(f.start), { code: 'TASK_NOT_VISIBLE' });
  const staleCallback = f.timers.keys().next().value;
  f.state.listVisible = true; f.state.thread.status = { type: 'idle' };
  await f.manager.handle({ method: 'turn/completed', params: { threadId: 'task', turn: { id: 'turn', status: 'completed' } } });
  assert.equal(f.timers.size, 0);
  staleCallback(); await f.manager.drain();
  assert.deepEqual(f.moves.map(m => m.sectionId), [sections.forReview.desktopId]);
});

test('pinning during visibility delay blocks the retained start', async t => {
  const f = startupFixture(t);
  await assert.rejects(f.manager.handle(f.start), { code: 'TASK_NOT_VISIBLE' });
  f.state.listVisible = true; f.state.thread.section = { id: pinnedId, name: 'Pinned' };
  await f.retry();
  assert.equal(f.moves.length, 0); assert.equal(f.timers.size, 0);
});

test('For Later placement during a retry revokes the earlier explicit start', async t => {
  const f = startupFixture(t);
  await assert.rejects(f.manager.handle(newStart()), { code: 'TASK_NOT_VISIBLE' });
  f.state.listVisible = true; f.state.thread.status = { type: 'active', activeFlags: [] };
  f.state.thread.section = { id: laterId, name: 'For Later' }; f.state.thread.sectionEnteredAt = 102;
  await f.retry();
  assert.equal(f.moves.length, 0); assert.equal(f.timers.size, 0);
});

for (const project of [null, 'project']) test(`new task visible at 1.2 seconds moves by 1.5 seconds (project=${project})`, async t => {
  const f = startupFixture(t); f.state.thread.projectId = project;
  await assert.rejects(f.manager.handle(f.start), { code: 'TASK_NOT_VISIBLE' });
  let elapsed = 0;
  while (f.timers.size) {
    elapsed += f.timers.values().next().value;
    f.state.listVisible = elapsed >= 1200;
    if (f.state.listVisible) f.state.thread.status = { type: 'active', activeFlags: [] };
    await f.retry();
    assert.ok(elapsed <= 1500, 'Visibility recovery must not wait until the old three-second retry');
  }
  assert.equal(elapsed, 1500);
  assert.deepEqual(f.moves.map(m => m.sectionId), [sections.inProgress.desktopId]);
  assert.equal(f.state.thread.projectId, project);
});

test('transport failure retains the original backoff instead of fast visibility retries', async t => {
  const f = startupFixture(t, { onCall({ method }) {
    if (method === 'thread/list') throw Error('Transport unavailable');
  } });
  await assert.rejects(f.manager.handle(f.start), { code: 'DESKTOP_MCP_UNAVAILABLE' });
  const delays = [];
  while (f.timers.size) { assert.ok(delays.length < 4); delays.push(await f.retry()); }
  assert.deepEqual(delays, [250, 750, 2000, 5000]);
  assert.equal(f.moves.length, 0);
});

test('idle-only visibility failure does not activate fast start retries', async t => {
  const f = startupFixture(t); f.state.thread.status = { type: 'idle' };
  await assert.rejects(f.manager.handle({ method: 'thread/status/changed',
    params: { threadId: 'task', status: { type: 'idle' } } }), { code: 'TASK_NOT_VISIBLE' });
  const delays = [];
  while (f.timers.size) { assert.ok(delays.length < 4); delays.push(await f.retry()); }
  assert.deepEqual(delays, [250, 750, 2000, 5000]);
  assert.equal(f.moves.length, 0);
});

test('stop cancels a dense visibility retry and its stale callback cannot move', async t => {
  const f = startupFixture(t);
  await assert.rejects(f.manager.handle(f.start), { code: 'TASK_NOT_VISIBLE' });
  await f.retry(); await f.retry();
  const staleCallback = f.timers.keys().next().value;
  f.manager.stop(); f.state.listVisible = true;
  staleCallback(); await f.manager.drain();
  assert.equal(f.timers.size, 0); assert.equal(f.moves.length, 0);
});

for (const archived of [false, true]) test(`absent local task exhausts bounded dense retries (archived=${archived})`, async t => {
  const f = startupFixture(t); f.state.archived = archived;
  await assert.rejects(f.manager.handle(f.start), { code: 'TASK_NOT_VISIBLE' });
  const delays = [];
  while (f.timers.size) {
    assert.ok(delays.length < 9, 'No unlimited retry');
    delays.push(await f.retry());
  }
  assert.deepEqual(delays, [250, 250, 250, 250, 500, 500, 1000, 2000, 3000]);
  assert.equal(delays.reduce((total, delay) => total + delay, 0), 8000);
  assert.equal(f.moves.length, 0);
});

test('malformed local response is not reclassified as a visibility delay', async t => {
  const f = startupFixture(t); f.state.archivePages = { first: { data: null } };
  await assert.rejects(f.manager.handle(f.start), /Invalid local task page/);
  assert.equal(f.timers.size, 0); assert.equal(f.moves.length, 0);
});

for (const project of [null, 'project']) test(`fast-path moves invisible active task without any task list (project=${project})`, async () => {
  const f = fixture({ activeFastPath: true, sourceSection: null });
  f.state.thread.section = null; f.state.thread.projectId = project; f.state.listVisible = false;
  assert.equal((await f.observer.reconcile('task')).action, 'moved');
  assert.equal(f.moves[0].sectionId, sections.inProgress.desktopId);
  assert.equal(f.state.thread.projectId, project);
  assert.equal(f.calls.filter(c => c.method === 'thread/list').length, 0);
  assert.equal((await f.observer.reconcile('task')).action, 'unchanged');
  assert.equal(f.moves.length, 1);
});

for (const status of [{ type: 'idle' }, { type: 'systemError' }, { type: 'notLoaded' },
  { type: 'active' }, { type: 'active', activeFlags: ['waitingOnApproval'] },
  { type: 'active', activeFlags: ['waitingOnUserInput'] }, { type: 'active', activeFlags: ['unknown'] }]) {
  test(`fast-path does not bypass visibility for ${JSON.stringify(status)}`, async () => {
    const f = fixture({ activeFastPath: true, status }); f.state.listVisible = false;
    await assert.rejects(f.observer.reconcile('task'), { code: 'TASK_NOT_VISIBLE' });
    assert.equal(f.moves.length, 0);
  });
}

for (const change of ['pin', 'archive', 'complete']) test(`fast-path rejects ${change} immediately before write`, async () => {
  const f = fixture({ activeFastPath: true, onCall({ method, state, calls }) {
    if (method !== 'thread/read' || calls.filter(c => c.method === method).length !== 3) return;
    if (change === 'pin') state.thread.section = { id: pinnedId };
    if (change === 'archive') { state.archived = true; state.thread.status = { type: 'notLoaded' }; }
    if (change === 'complete') state.thread.status = { type: 'idle' };
  } }); f.state.listVisible = false;
  await assert.rejects(f.observer.reconcile('task'));
  assert.equal(f.calls.filter(c => c.method === 'thread/read').length, 3);
  assert.equal(f.moves.length, 0);
});

test('fast-path still rejects directly Pinned and explicitly archived tasks', async () => {
  for (const field of ['pin', 'archived']) {
    const f = fixture({ activeFastPath: true }); f.state.listVisible = false;
    if (field === 'pin') f.state.thread.section = { id: pinnedId };
    else f.state.thread.archived = true;
    await assert.rejects(f.observer.reconcile('task'));
    assert.equal(f.moves.length, 0);
  }
});

test('fast-path keeps completion on the existing checked review path', async () => {
  const f = fixture({ activeFastPath: true }); f.state.listVisible = false;
  assert.equal((await f.observer.reconcile('task')).action, 'moved');
  f.state.thread.status = { type: 'idle' };
  await assert.rejects(f.observer.reconcile('task'), { code: 'TASK_NOT_VISIBLE' });
  f.state.listVisible = true;
  assert.equal((await f.observer.reconcile('task')).action, 'moved');
  assert.deepEqual(f.moves.map(m => m.sectionId), [sections.inProgress.desktopId, sections.forReview.desktopId]);
});

for (const field of ['remote', 'parent', 'source', 'ephemeral', 'id']) test(`fast-path rejects ineligible ${field}`, async () => {
  const f = fixture({ activeFastPath: true }); f.state.listVisible = false;
  if (field === 'remote') f.state.thread.hostId = 'remote-fixture';
  if (field === 'parent') f.state.thread.parentThreadId = 'parent';
  if (field === 'source') f.state.thread.source = { subAgent: 'review' };
  if (field === 'ephemeral') f.state.thread.ephemeral = true;
  if (field === 'id') f.state.thread.id = 'different';
  await assert.rejects(f.observer.reconcile('task'), /Ineligible/);
  assert.equal(f.moves.length, 0);
});

for (const project of [null, 'project']) test(`manager fast-path handles an invisible new task without retries (project=${project})`, async t => {
  const f = startupFixture(t, { status: { type: 'active', activeFlags: [] } });
  f.state.thread.projectId = project; f.state.thread.section = null;
  assert.equal((await f.manager.handle(f.start)).action, 'moved');
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.filter(c => c.method === 'thread/list').length, 0);
  assert.equal(f.state.thread.projectId, project);
  assert.equal((await f.manager.handle(f.start)).action, 'unchanged');
  assert.equal(f.moves.length, 1);
});

for (const method of ['thread/started', 'thread/status/changed']) test(`manager fast-path accepts native active ${method}`, async t => {
  const f = startupFixture(t, { status: { type: 'active', activeFlags: [] } });
  const params = method === 'thread/started' ? { thread: f.state.thread }
    : { threadId: 'task', status: f.state.thread.status };
  assert.equal((await f.manager.handle({ method, params })).action, 'moved');
  assert.equal(f.calls.filter(c => c.method === 'thread/list').length, 0);
});

test('manager does not enable fast-path for an idle event with a newly active read', async t => {
  const f = startupFixture(t, { status: { type: 'active', activeFlags: [] } });
  await assert.rejects(f.manager.handle({ method: 'thread/status/changed',
    params: { threadId: 'task', status: { type: 'idle' } } }), { code: 'TASK_NOT_VISIBLE' });
  assert.equal(f.moves.length, 0);
});

for (const activeFlags of [['waitingOnApproval'], ['waitingOnUserInput'], ['unknown'], undefined]) {
  test(`manager retains list checks for latest non-running flags ${JSON.stringify(activeFlags)}`, async t => {
    const f = startupFixture(t, { status: { type: 'active', activeFlags: [] } });
    await assert.rejects(f.manager.handle({ method: 'thread/status/changed',
      params: { threadId: 'task', status: { type: 'active', activeFlags } } }), { code: 'TASK_NOT_VISIBLE' });
    assert.equal(f.moves.length, 0);
  });
}

test('manager recovery stays conservative and cannot leak its policy into a live start', async t => {
  const f = startupFixture(t, { status: { type: 'active', activeFlags: [] } });
  f.state.recoveryPages = { first: { data: [f.state.thread], nextCursor: null } };
  await f.manager.reconcile();
  assert.ok(f.calls.some(c => c.method === 'thread/list' && c.params.cwd));
  assert.equal(f.moves.length, 0); assert.equal(f.timers.size, 0);
  assert.equal((await f.manager.handle(f.start)).action, 'moved');
});

test('manager cancels a held fast start when completion arrives', async t => {
  const f = fixture(); f.state.listVisible = false;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { entered = resolve; });
  let held = false;
  const manager = createDesktopObserverManager({ async request(method, params) {
    const result = await f.rpc.request(method, params);
    if (method === 'thread/read' && !held) { held = true; entered(); await gate; }
    return result;
  } }, { readConfig: () => ({ version: 1, mode: 'all-local', forceStatusSections: sections }) });
  t.after(() => manager.stop());
  const first = manager.handle({ method: 'turn/started', params: { threadId: 'task', turn: { id: 'turn' } } });
  await reading;
  f.state.thread.status = { type: 'idle' }; f.state.listVisible = true;
  const done = manager.handle({ method: 'turn/completed', params: { threadId: 'task', turn: { id: 'turn', status: 'completed' } } });
  release();
  const results = await Promise.all([first, done]);
  assert.equal(results[0].reason, 'superseded');
  assert.deepEqual(f.moves.map(m => m.sectionId), [sections.forReview.desktopId]);
  assert.ok(f.calls.some(c => c.method === 'thread/list'));
});

for (const change of ['disable', 'exclude']) test(`manager fast-path stops after configuration ${change}`, async t => {
  let config = { version: 1, mode: 'all-local', forceStatusSections: sections };
  const f = fixture({ onCall({ method, calls }) {
    if (method === 'thread/read' && calls.filter(c => c.method === method).length === 3)
      config = change === 'disable' ? { ...config, mode: 'disabled' } : { ...config, excludedThreadIds: ['task'] };
  } }); f.state.listVisible = false;
  const manager = createDesktopObserverManager(f.rpc, { readConfig: () => config });
  t.after(() => manager.stop());
  await assert.rejects(manager.handle({ method: 'turn/started', params: { threadId: 'task', turn: { id: 'turn' } } }));
  assert.equal(f.calls.filter(c => c.method === 'thread/read').length, 3);
  assert.equal(f.moves.length, 0);
});
