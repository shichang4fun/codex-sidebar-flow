import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
const url = new URL('../experimental/desktop-observer-manager.mjs', import.meta.url);

test('dynamic observer manager exists', () => assert.ok(existsSync(url)));
test('all-local discovers new tasks, excludes organizer, and reloads disable policy', async () => {
  if (!existsSync(url)) return;
  const { createDesktopObserverManager } = await import(url);
  let config = { version: 1, mode: 'all-local', excludedThreadIds: ['organizer'] };
  let section = 'review', status = { type: 'active', activeFlags: [] };
  const moves = [], calls = [];
  const rpc = { async request(method, p) {
    assert.equal(method, 'mcpServer/tool/call'); calls.push(p);
    const id = p.threadId;
    const sections = [{ sectionId: 'progress', name: 'In Progress', itemKeys: [] },
      { sectionId: 'review', name: 'For Review', itemKeys: [] },
      { sectionId: 'later', name: 'For Later', itemKeys: [] }];
    sections.find(s => s.sectionId === section).itemKeys.push(`codex:thread:local:${id}`);
    const thread = { id, kind: 'codex', hostId: 'local', projectId: null, status };
    let result;
    if (p.tool === 'list_threads') result = { threads: [thread], pinnedThreads: [], sections };
    else if (p.tool === 'read_thread') result = { thread };
    else if (p.tool === 'move_thread_to_sidebar_section') {
      section = p.arguments.sectionId; moves.push(section); result = p.arguments;
    } else assert.fail(p.tool);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } };
  const manager = createDesktopObserverManager(rpc, { readConfig: () => config });
  const event = id => ({ method: 'thread/status/changed', params: { threadId: id, status } });
  await manager.handle(event('organizer')); assert.equal(calls.length, 0);
  await manager.handle(event('new-local')); assert.deepEqual(moves, ['progress']);
  await manager.handle(event('new-local')); assert.deepEqual(moves, ['progress']);
  status = { type: 'idle' };
  await manager.handle(event('new-local')); assert.deepEqual(moves, ['progress', 'review']);
  config = { version: 1, mode: 'disabled' }; status = { type: 'active', activeFlags: [] };
  const count = calls.length;
  await manager.handle(event('new-local')); assert.equal(calls.length, count);
  config = { broken: true };
  await assert.rejects(manager.handle(event('new-local')));
  assert.equal(calls.length, count);
});

test('failed identities do not permanently consume observer slots', async () => {
  if (!existsSync(url)) return;
  const { createDesktopObserverManager } = await import(url);
  let calls = 0;
  const manager = createDesktopObserverManager({ async request() { calls++; throw Error('ineligible'); } }, {
    readConfig: () => ({ version: 1, mode: 'all-local' }),
  });
  for (let i = 0; i < 270; i++) {
    await assert.rejects(manager.handle({ method: 'turn/started', params: { threadId: `task-${i}` } }));
  }
  assert.equal(calls, 270);
});

test('duplicate event bursts and the terminal event are coalesced, not dropped', async () => {
  if (!existsSync(url)) return;
  const { createDesktopObserverManager } = await import(url);
  let calls = 0;
  const manager = createDesktopObserverManager({ async request() { calls++; throw Error('test RPC failure'); } }, {
    readConfig: () => ({ version: 1, mode: 'all-local' }),
  });
  const work = Array.from({ length: 80 }, () => manager.handle({ method: 'turn/started', params: { threadId: 'same-task' } }));
  work.push(manager.handle({ method: 'turn/completed', params: { threadId: 'same-task' } }));
  const result = await Promise.allSettled(work);
  assert.ok(result.every(r => r.status === 'rejected'), 'No terminal event may report queue-limit');
  assert.equal(calls, 1, 'Same-task burst must use one reconciliation');
});
