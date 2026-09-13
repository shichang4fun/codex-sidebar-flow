import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../experimental/desktop-mcp-adapter.mjs';
test('desktop MCP adapter exists', () => assert.equal(typeof api.desktopMcpAdapter, 'function'));
const threadId = 'local-test';
function fixture(readFields = {}) {
  const calls = [];
  const snapshot = {
    pinnedThreads: [], threads: [{ id: threadId, hostId: 'local', kind: 'codex', projectId: null }],
    sections: [{ sectionId: 'chats', name: 'Tasks', itemKeys: [`codex:thread:local:${threadId}`] },
      { sectionId: 'progress', name: 'In Progress', itemKeys: [] }],
  };
  const rpc = { async request(method, params) {
    calls.push({ method, params });
    assert.equal(method, 'mcpServer/tool/call');
    assert.equal(params.threadId, threadId);
    assert.equal(params.server, 'codex_app');
    assert.equal(params._meta, undefined, 'Must rely on executor metadata, not fabricate it');
    let value;
    if (params.tool === 'list_threads') value = snapshot;
    else if (params.tool === 'read_thread') value = { thread: { id: threadId, hostId: 'local', kind: 'codex', status: { type: 'active', activeFlags: [] }, ...readFields } };
    else if (params.tool === 'move_thread_to_sidebar_section') value = { ...params.arguments };
    else assert.fail('Unexpected tool');
    return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
  } };
  return { calls, snapshot, adapter: () => api.desktopMcpAdapter(rpc, threadId) };
}
test('uses official MCP bridge, structured local identity and Desktop section IDs', async () => {
  const f = fixture(), adapter = f.adapter();
  assert.equal((await adapter.request('threadSection/list')).data[1].id, 'progress');
  const result = await adapter.request('thread/read', { threadId });
  assert.equal(result.thread.section, null);
  await adapter.request('thread/section/move', { threadId, sectionId: 'progress' });
  assert.deepEqual(f.calls.at(-1).params.arguments, { threadId, hostId: 'local', sectionId: 'progress' });
});
test('rejects remote, ambiguous, unknown Project, missing and malformed membership', async () => {
  for (const change of [
    s => { s.threads[0].hostId = 'remote-control:test'; },
    s => { s.threads.push({ ...s.threads[0] }); },
    s => { s.threads[0].projectId = 'project'; },
    s => { s.sections[0].itemKeys = []; },
    s => { s.sections[1].itemKeys = [...s.sections[0].itemKeys]; },
    s => { s.sections[0].itemKeys = [`chatgpt:conversation:${threadId}`]; },
  ]) {
    const f = fixture(); change(f.snapshot);
    await assert.rejects(f.adapter().request('thread/read', { threadId }));
  }
});

test('Project child without direct membership can move without losing its project identity', async () => {
  const f = fixture();
  f.snapshot.threads[0].projectId = 'project';
  f.snapshot.sections[0].itemKeys = [];
  f.snapshot.sections.push({ sectionId: 'threads', name: 'Projects', itemKeys: ['codex:project:project'] });
  const adapter = f.adapter();
  const result = await adapter.request('thread/read', { threadId });
  assert.equal(result.thread.projectId, 'project');
  assert.equal(result.thread.section, null);
  assert.deepEqual(await adapter.candidates(), [threadId]);
  await adapter.request('thread/section/move', { threadId, sectionId: 'progress' });
  assert.deepEqual(f.calls.at(-1).params.arguments, { threadId, hostId: 'local', sectionId: 'progress' });
});

test('Project ancestry protects pinned, later and custom groups even with direct managed membership', async () => {
  for (const sectionId of ['pinned', 'later', 'other']) {
    const f = fixture();
    f.snapshot.threads[0].projectId = 'project';
    f.snapshot.sections.push({ sectionId, name: sectionId, itemKeys: ['codex:project:project'] });
    await assert.rejects(f.adapter().request('thread/section/move', { threadId, sectionId: 'progress' }));
    assert.ok(!f.calls.some(c => c.params.tool === 'move_thread_to_sidebar_section'));
  }
});

test('fresh association with another Project rejects a stale list identity', async () => {
  const f = fixture({ projectId: 'different-project' });
  f.snapshot.threads[0].projectId = 'project';
  f.snapshot.sections.push({ sectionId: 'threads', name: 'Projects', itemKeys: ['codex:project:project'] });
  await assert.rejects(f.adapter().request('thread/section/move', { threadId, sectionId: 'progress' }));
});
test('cannot use this adapter to operate another task or invoke arbitrary tools', async () => {
  const f = fixture(), adapter = f.adapter();
  await assert.rejects(adapter.request('thread/section/move', { threadId: 'other', sectionId: 'progress' }));
  await assert.rejects(adapter.request('turn/start', {}));
  assert.equal(f.calls.length, 0);
});
test('MCP tool errors cannot be interpreted as successful writes', async () => {
  const adapter = api.desktopMcpAdapter({ async request() { return { isError: true, content: [{ type: 'text', text: '{}' }] }; } }, threadId);
  await assert.rejects(adapter.request('threadSection/list'), /MCP/i);
});

test('unavailable remote hosts do not disable authoritative local tasks', async () => {
  const f = fixture();
  f.snapshot.unavailableHosts = ['remote-control:offline'];
  assert.equal((await f.adapter().request('thread/read', { threadId })).thread.id, threadId);
});

test('move rechecks authoritative active status immediately before changing a section', async () => {
  const f = fixture();
  await f.adapter().request('thread/section/move', { threadId, sectionId: 'progress' });
  const tools = f.calls.map(c => c.params.tool);
  assert.deepEqual(tools.slice(-2), ['read_thread', 'move_thread_to_sidebar_section']);
});

test('fresh Project membership prevents reads and moves despite a stale local list', async () => {
  for (const method of ['thread/read', 'thread/section/move']) {
    const f = fixture({ projectId: 'newly-assigned-project' });
    await assert.rejects(f.adapter().request(method, { threadId, sectionId: 'progress' }));
    assert.ok(!f.calls.some(c => c.params.tool === 'move_thread_to_sidebar_section'));
  }
});
