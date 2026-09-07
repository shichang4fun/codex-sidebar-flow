// Explicit opt-in integration: real Codex binary, isolated home, loopback fake model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { connectRpc, createObserver } from '../experimental/app-server-observer.mjs';
import { createStdioRelay } from '../experimental/stdio-relay.mjs';

async function relayedClient(child) {
  const pending = new Map(), listeners = new Set();
  let id = 0;
  const relay = createStdioRelay({
    toServer: message => child.stdin.write(JSON.stringify(message) + '\n'),
    toDesktop: message => {
      const p = !message.method && pending.get(message.id);
      if (p) {
        clearTimeout(p.timer); pending.delete(message.id);
        if (message.error) p.reject(Error(JSON.stringify(message.error))); else p.resolve(message.result);
      } else for (const callback of listeners) callback(message);
    },
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => relay.fromServer(JSON.parse(line)));
  const actor = {
    request(method, params = {}) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(Error('Fixture RPC timeout')); }, 5000);
        pending.set(requestId, { resolve, reject, timer });
        relay.fromDesktop({ id: requestId, method, params });
      });
    },
    subscribe(callback) { listeners.add(callback); },
    close() { lines.close(); relay.close(); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('closed')); } pending.clear(); },
  };
  await actor.request('initialize', { clientInfo: { name: 'sidebar_desktop_fixture', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  // Match Desktop: no follow-up initialized notification after the response.
  return { actor, watcher: relay };
}

for (const transport of ['websocket', 'stdio-relay', 'stdio-proxy']) test(`real App Server lifecycle, section moves and direct MCP calls: ${transport}`, {
  skip: !process.env.SIDEBAR_TEST_CODEX_BINARY,
  timeout: 30000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidebar-official-api-test-'));
  let child, actor, watcher;
  t.after(async () => {
    watcher?.close(); actor?.close();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
    }
    fixture.closeAllConnections(); fixture.close();
    await rm(root, { recursive: true, force: true });
  });
  const fixture = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    send({ type: 'response.created', response: { id: 'fixture-response', status: 'in_progress', output: [] } });
    // Hold the response open so the observer has time to read the genuine active state.
    setTimeout(() => {
      const item = { id: 'fixture-message', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
      send({ type: 'response.output_item.done', output_index: 0, item });
      send({ type: 'response.completed', response: { id: 'fixture-response', status: 'completed',
        output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
      res.end();
    }, 800);
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const portReservation = createTcpServer();
  portReservation.listen(0, '127.0.0.1');
  await once(portReservation, 'listening');
  const port = portReservation.address().port;
  await new Promise(resolve => portReservation.close(resolve));
  const endpoint = `ws://127.0.0.1:${port}`;
  const commandArgs = [
    '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false',
    '-c', 'model_provider="fixture"', '-c', 'model="fixture"',
    '-c', `model_providers.fixture={name="Local fixture",base_url="http://127.0.0.1:${fixture.address().port}/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`,
    '-c', `mcp_servers.probe={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(fileURLToPath(new URL('../fixtures/mcp-official-api-probe.mjs', import.meta.url)))}]}`,
    '--disable', 'hooks', 'app-server', '--listen', transport === 'websocket' ? endpoint : 'stdio://',
  ];
  const proxy = transport === 'stdio-proxy';
  child = spawn(proxy ? process.execPath : process.env.SIDEBAR_TEST_CODEX_BINARY,
    proxy ? [fileURLToPath(new URL('../experimental/stdio-observer-proxy.mjs', import.meta.url)), ...commandArgs] : commandArgs,
    { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: root,
    ...(proxy ? { SIDEBAR_FLOW_REAL_CODEX: process.env.SIDEBAR_TEST_CODEX_BINARY, SIDEBAR_FLOW_TEST_THREADS: '["unmatched-fixture-task"]' } : {}),
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.on('error', error => { stderr = error.message; });
  if (transport !== 'websocket') {
    ({ actor, watcher } = await relayedClient(child));
  } else {
    child.stdout.resume();
    for (let i = 0; i < 40; i++) {
      try { actor = await connectRpc(endpoint, { timeoutMs: 500 }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(actor, 'Isolated server must start: ' + stderr);
    watcher = await connectRpc(endpoint);
  }
  const sections = {};
  for (const name of ['In Progress', 'For Review', 'For Later']) {
    const response = await actor.request('threadSection/create', { name });
    sections[name] = response.section;
  }
  const { thread } = await actor.request('thread/start', {
    cwd: root, model: 'fixture', modelProvider: 'fixture', sandbox: 'read-only', approvalPolicy: 'never',
    baseInstructions: 'Reply OK. Do not use tools.',
  });
  const observer = createObserver(watcher, { threadIds: [thread.id], apply: true });
  const events = [];
  const actorErrors = [];
  actor.subscribe(message => {
    if (message.method === 'error' || message.method === 'turn/completed') actorErrors.push(message);
  });
  const outcomes = [];
  const mcpCalls = [];
  let completed;
  const done = new Promise(resolve => { completed = resolve; });
  watcher.subscribe(message => {
    if (message.params?.threadId !== thread.id) return;
    if (!['thread/status/changed', 'turn/started', 'turn/completed'].includes(message.method)) return;
    events.push({ method: message.method, status: message.params.status?.type });
    if (message.method === 'thread/status/changed') {
      mcpCalls.push(watcher.request('mcpServer/tool/call', {
        threadId: thread.id, server: 'probe', tool: 'probe', arguments: { marker: message.params.status.type },
      }));
    }
    const receivedAt = Date.now();
    observer.handle(message).then(result => {
      result.observerLatencyMs = Date.now() - receivedAt;
      outcomes.push(result);
      if (result.action === 'moved' && result.sectionId === sections['For Review']?.id) completed();
    }, error => { outcomes.push({ error: error.message }); completed(); });
  });
  // Reading is non-mutating. Do not resume or start a copy through the observer.
  await watcher.request('thread/read', { threadId: thread.id });
  const loaded = await watcher.request('thread/loaded/list', { limit: 1000 });
  assert.ok(loaded.data.includes(thread.id), 'Read-only loaded task discovery supplies a context without starting another turn');
  await actor.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Say OK', text_elements: [] }] });
  let timer;
  await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 12000); })]);
  clearTimeout(timer);
  t.diagnostic(JSON.stringify({ events, outcomes, turnStatuses: actorErrors.map(e => e.params?.turn?.status ?? 'error') }));
  assert.ok(events.some(e => e.status === 'active'), 'Independent watcher must receive active status');
  assert.ok(events.some(e => e.status === 'idle'), 'Independent watcher must receive idle status');
  assert.ok(outcomes.some(r => r.action === 'moved' && r.sectionId === sections['In Progress'].id));
  assert.ok(outcomes.some(r => r.action === 'moved' && r.sectionId === sections['For Review'].id));
  const final = await actor.request('thread/read', { threadId: thread.id });
  assert.equal(final.thread.section?.id, sections['For Review'].id);
  // Simulate a missed terminal event in this isolated server, not the user's Desktop.
  await actor.request('thread/section/move', { threadId: thread.id, sectionId: sections['In Progress'].id });
  const restartedObserver = createObserver(watcher, { threadIds: [thread.id], apply: true });
  assert.equal((await restartedObserver.reconcile(thread.id)).sectionId, sections['For Review'].id);
  const mcpResults = await Promise.all(mcpCalls);
  const markers = mcpResults.map(r => JSON.parse(r.content[0].text).marker);
  assert.ok(markers.includes('active'));
  assert.ok(markers.includes('idle'));
  assert.ok(mcpResults.every(r => JSON.parse(r.content[0].text).meta.threadId === thread.id));
  t.diagnostic(JSON.stringify({ directMcpMarkers: markers, executorSuppliedThreadIdentity: true, modelRequiredForToolCalls: false }));
});
