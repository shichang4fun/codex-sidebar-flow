import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopObserverManager } from '../experimental/desktop-observer-manager.mjs';

function fixture() {
  let config = { version: 1, mode: 'all-local', excludedThreadIds: ['organizer'] };
  const tasks = [
    ['missed-start', 'review', 'active'], ['missed-stop', 'progress', 'idle'],
    ['untouched-idle', 'chats', 'idle'], ['pinned-task', 'pinned', 'active'],
    ['later-task', 'later', 'active'], ['organizer', 'progress', 'idle'],
    ['remote-task', 'progress', 'idle'], ['project-task', 'progress', 'idle'],
  ].map(([id, section, type]) => ({ id, section, status: { type, ...(type === 'active' ? { activeFlags: [] } : {}) },
    hostId: id === 'remote-task' ? 'remote-control:test' : 'local', kind: 'codex',
    projectId: id === 'project-task' ? 'project' : null }));
  const moves = [], calls = [];
  const rpc = { async request(method, p) {
    calls.push({ method, p });
    if (method === 'thread/loaded/list') return { data: ['missed-start'], nextCursor: null };
    assert.equal(method, 'mcpServer/tool/call');
    assert.equal(p.threadId, 'missed-start', 'Native tool execution must use the loaded context, not the unloaded repair target');
    let result;
    if (p.tool === 'list_threads') {
      assert.ok(p.arguments.limit <= 50, 'Native Desktop list_threads has a hard maximum of 50');
      result = {
      threads: tasks.filter(t => t.section !== 'pinned'), pinnedThreads: tasks.filter(t => t.section === 'pinned'),
      sections: [['chats', 'Tasks'], ['progress', 'In Progress'], ['review', 'For Review'], ['later', 'For Later'], ['pinned', 'Pinned']]
        .map(([sectionId, name]) => ({ sectionId, name,
          itemKeys: tasks.filter(t => t.section === sectionId).map(t => `codex:thread:local:${t.id}`) })),
      };
    }
    else if (p.tool === 'read_thread') result = { thread: tasks.find(t => t.id === p.arguments.threadId) };
    else if (p.tool === 'move_thread_to_sidebar_section') {
      assert.equal(p.arguments.hostId, 'local');
      tasks.find(t => t.id === p.arguments.threadId).section = p.arguments.sectionId;
      moves.push(p.arguments); result = p.arguments;
    } else assert.fail(p.tool);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } };
  return { manager: createDesktopObserverManager(rpc, { readConfig: () => config }), moves, calls, tasks, rpc,
    config: value => { config = value; } };
}

test('periodic snapshot repairs missed starts including For Later and preserves protected groups', async () => {
  const f = fixture();
  assert.equal(typeof f.manager.reconcile, 'function');
  const result = await f.manager.reconcile();
  assert.equal(result.moved, 3);
  assert.deepEqual(f.moves.map(m => [m.threadId, m.sectionId]), [
    ['missed-start', 'progress'], ['missed-stop', 'review'], ['later-task', 'progress'],
  ]);
  await f.manager.reconcile();
  assert.equal(f.moves.length, 3, 'Repeated compensation must be idempotent');
  assert.ok(!f.calls.some(c => c.p?.tool === 'read_thread' && ['organizer', 'remote-task', 'project-task', 'pinned-task'].includes(c.p.arguments.threadId)));
});

test('disabled/malformed compensation configuration performs no native calls', async () => {
  for (const config of [{ version: 1, mode: 'disabled' }, { version: 1, mode: 'all-local', reconcileIntervalSeconds: 0 }, {}]) {
    const f = fixture(); f.config(config);
    await f.manager.reconcile().catch(() => {});
    assert.equal(f.calls.length, 0);
  }
});

test('compensation yields to queued events, then overlapping idle scans coalesce', async () => {
  const f = fixture();
  const a = f.manager.reconcile(), b = f.manager.reconcile();
  const results = await Promise.all([a, b, f.manager.handle({ method: 'turn/started', params: { threadId: 'missed-start' } })]);
  assert.equal(results[0].action, 'deferred');
  assert.equal(results[1].action, 'deferred');
  assert.equal(f.calls.filter(c => c.method === 'thread/loaded/list').length, 0);
  await Promise.all([f.manager.reconcile(), f.manager.reconcile()]);
  assert.equal(f.calls.filter(c => c.method === 'thread/loaded/list').length, 1);
  assert.equal(f.moves.filter(m => m.threadId === 'missed-start').length, 1);
});

test('bounded batches rotate instead of starving older candidates', async () => {
  const f = fixture();
  for (let n = 0; n < 30; n++) f.tasks.push({ id: `stale-${n}`, section: 'progress', status: { type: 'idle' },
    hostId: 'local', kind: 'codex', projectId: null });
  assert.equal((await f.manager.reconcile()).checked, 20);
  assert.equal((await f.manager.reconcile()).checked, 20);
  assert.equal(f.moves.filter(m => m.threadId.startsWith('stale-')).length, 30);
});

test('an event arriving during loaded-task discovery prevents a new compensation snapshot', async () => {
  const f = fixture(), request = f.rpc.request;
  let releaseLoaded, releaseEvent, notifyLoaded, notifyEvent;
  const loadedStarted = new Promise(resolve => { notifyLoaded = resolve; });
  const eventStarted = new Promise(resolve => { notifyEvent = resolve; });
  f.rpc.request = async (method, p) => {
    if (method === 'thread/loaded/list') {
      notifyLoaded(); await new Promise(resolve => { releaseLoaded = resolve; });
    } else if (p.tool === 'list_threads' && !releaseEvent) {
      notifyEvent(); await new Promise(resolve => { releaseEvent = resolve; });
    }
    return request(method, p);
  };
  const scan = f.manager.reconcile();
  await loadedStarted;
  const event = f.manager.handle({ method: 'turn/started', params: { threadId: 'missed-start' } });
  await eventStarted;
  releaseLoaded();
  assert.equal((await scan).action, 'deferred');
  assert.equal(f.calls.filter(c => c.p?.tool === 'list_threads').length, 0);
  releaseEvent(); await event;
  assert.equal(f.moves.length, 1);
});

test('hot disable blocks pending recovery writes without disabling real events', async () => {
  const f = fixture(), request = f.rpc.request;
  f.rpc.request = async (method, p) => {
    const result = await request(method, p);
    if (p.tool === 'read_thread') f.config({ version: 1, mode: 'all-local', reconcileIntervalSeconds: 0 });
    return result;
  };
  await f.manager.reconcile(); assert.equal(f.moves.length, 0);
  await f.manager.handle({ method: 'turn/started', params: { threadId: 'missed-start' } });
  assert.equal(f.moves.length, 1);
});

test('event queued during a candidate repair defers the next repair without losing round-robin progress', async () => {
  const f = fixture(), request = f.rpc.request;
  let releaseRepair, notifyRepair;
  const repairStarted = new Promise(resolve => { notifyRepair = resolve; });
  f.rpc.request = async (method, p) => {
    if (p.tool === 'read_thread' && !releaseRepair) {
      notifyRepair(); await new Promise(resolve => { releaseRepair = resolve; });
    }
    return request(method, p);
  };
  const scan = f.manager.reconcile();
  await repairStarted;
  const event = f.manager.handle({ method: 'turn/started', params: { threadId: 'missed-start' } });
  releaseRepair();
  // The queued event starts before the scan considers its second candidate.
  const result = await scan;
  assert.equal(result.action, 'deferred');
  assert.equal(result.checked, 1);
  assert.equal(f.moves.some(m => m.threadId === 'missed-stop'), false);
  await event;
  const previousReads = f.calls.filter(c => c.p?.tool === 'read_thread').length;
  await f.manager.reconcile();
  const newReads = f.calls.filter(c => c.p?.tool === 'read_thread').slice(previousReads);
  assert.equal(newReads[0].p.arguments.threadId, 'missed-stop');
  assert.equal(f.moves.filter(m => m.threadId === 'missed-start').length, 1);
  assert.equal(f.moves.filter(m => m.threadId === 'missed-stop').length, 1);
});
