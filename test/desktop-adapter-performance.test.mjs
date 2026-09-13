import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopMcpAdapter } from '../experimental/desktop-mcp-adapter.mjs';
import { createObserver } from '../experimental/app-server-observer.mjs';

const threadId = 'performance-test';
function fixture({ project = false, onCall = () => {} } = {}) {
  const calls = [];
  const task = { id: threadId, hostId: 'local', kind: 'codex', projectId: project ? 'project' : null,
    status: { type: 'active', activeFlags: [] } };
  const data = { threads: [task], pinnedThreads: [], sections: [
    { sectionId: 'chats', name: 'Tasks', itemKeys: project ? [] : [`codex:thread:local:${threadId}`] },
    { sectionId: 'threads', name: 'Projects', itemKeys: project ? ['codex:project:project'] : [] },
    { sectionId: 'progress', name: 'In Progress', itemKeys: [] },
    { sectionId: 'review', name: 'For Review', itemKeys: [] },
    { sectionId: 'later', name: 'For Later', itemKeys: [] },
  ] };
  function place(sectionId) {
    for (const section of data.sections) section.itemKeys = section.itemKeys.filter(k => k !== `codex:thread:local:${threadId}`);
    data.sections.find(s => s.sectionId === sectionId).itemKeys.push(`codex:thread:local:${threadId}`);
  }
  const adapter = desktopMcpAdapter({ async request(method, params) {
    assert.equal(method, 'mcpServer/tool/call');
    calls.push(params.tool);
    onCall({ tool: params.tool, calls, data, task, place });
    let value;
    if (params.tool === 'list_threads') value = data;
    else if (params.tool === 'read_thread') value = { thread: task };
    else if (params.tool === 'move_thread_to_sidebar_section') {
      place(params.arguments.sectionId);
      value = params.arguments;
    } else assert.fail('Unexpected tool');
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  } }, threadId);
  return { calls, data, task, place, adapter,
    observer: createObserver(adapter, { threadIds: [threadId], apply: true, allowProjectTasks: true }) };
}

test('one move uses three sidebar snapshots including a fresh prewrite guard and postwrite readback', async () => {
  const f = fixture();
  assert.equal((await f.observer.reconcile(threadId)).action, 'moved');
  assert.equal(f.calls.filter(c => c === 'list_threads').length, 3);
  const move = f.calls.indexOf('move_thread_to_sidebar_section');
  assert.deepEqual(f.calls.slice(move - 2, move + 3), [
    'list_threads', 'read_thread', 'move_thread_to_sidebar_section', 'list_threads', 'read_thread',
  ]);
});

test('unchanged reconciliation uses one snapshot and starts fresh on the next event', async () => {
  const f = fixture();
  f.place('progress');
  assert.equal((await f.observer.reconcile(threadId)).action, 'unchanged');
  assert.equal(f.calls.filter(c => c === 'list_threads').length, 1);
  f.place('later');
  assert.equal((await f.observer.handle({ method: 'turn/started', params: { threadId } })).action, 'skipped');
  assert.equal(f.calls.filter(c => c === 'list_threads').length, 2);
  assert.equal(f.calls.includes('move_thread_to_sidebar_section'), false);
});

test('fresh move snapshot rejects a task whose managed membership changed during reads', async () => {
  const f = fixture({ onCall({ tool, calls, place }) {
    if (tool === 'read_thread' && calls.filter(c => c === tool).length === 2) place('review');
  } });
  await assert.rejects(f.observer.reconcile(threadId), /Task changed before move/);
  assert.equal(f.calls.includes('move_thread_to_sidebar_section'), false);
});

test('fresh move snapshot rejects a Project pinned during reads', async () => {
  const f = fixture({ project: true, onCall({ tool, calls, data }) {
    if (tool === 'read_thread' && calls.filter(c => c === tool).length === 2) {
      data.sections.find(s => s.sectionId === 'threads').itemKeys = [];
      data.sections.push({ sectionId: 'pinned', name: 'Pinned', itemKeys: ['codex:project:project'] });
    }
  } });
  await assert.rejects(f.observer.reconcile(threadId), /Protected or unknown Project/);
  assert.equal(f.calls.includes('move_thread_to_sidebar_section'), false);
});

test('read failure discards the transaction snapshot before retry', async () => {
  let fail = true;
  const f = fixture({ onCall({ tool }) {
    if (tool === 'read_thread' && fail) { fail = false; throw Error('Unavailable'); }
  } });
  await assert.rejects(f.observer.reconcile(threadId), /DESKTOP_MCP_UNAVAILABLE/);
  f.place('later');
  assert.equal((await f.observer.reconcile(threadId)).action, 'skipped');
  assert.equal(f.calls.filter(c => c === 'list_threads').length, 2);
  assert.equal(f.calls.includes('move_thread_to_sidebar_section'), false);
});

test('transaction still rejects a changed authoritative status immediately before writing', async () => {
  const f = fixture({ onCall({ tool, calls, task }) {
    if (tool === 'read_thread' && calls.filter(c => c === tool).length === 3) task.status = { type: 'idle' };
  } });
  await assert.rejects(f.observer.reconcile(threadId), /Task changed before move/);
  assert.equal(f.calls.includes('move_thread_to_sidebar_section'), false);
});

test('postwrite verification reads fresh membership instead of accepting the move response', async () => {
  const f = fixture({ onCall({ tool, calls, place }) {
    if (tool === 'list_threads' && calls.includes('move_thread_to_sidebar_section')) place('review');
  } });
  await assert.rejects(f.observer.reconcile(threadId), /Server section readback mismatch/);
  assert.equal(f.calls.filter(c => c === 'move_thread_to_sidebar_section').length, 1);
});

test('direct adapter reads outside reconciliation never reuse a snapshot', async () => {
  const f = fixture();
  assert.equal((await f.adapter.request('thread/read', { threadId })).thread.section, null);
  f.place('later');
  assert.equal((await f.adapter.request('thread/read', { threadId })).thread.section.id, 'later');
  assert.equal(f.calls.filter(c => c === 'list_threads').length, 2);
});
