import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
const script = fileURLToPath(new URL('../experimental/stdio-observer-proxy.mjs', import.meta.url));
test('installed proxy persists a content-free timing summary for a real relayed event', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidebar-proxy-timing-'));
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, mode: 'all-local', reconcileIntervalSeconds: 0 }));
  const server = `let section='review'; const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);
      if(m.method==='initialize'){send({id:m.id,result:{}});send({method:'turn/started',params:{threadId:'test',private:'PRIVATE_EVENT'}});return;}
      if(m.method!=='mcpServer/tool/call')process.exit(9);
      const p=m.params, thread={id:'test',kind:'codex',hostId:'local',projectId:null,status:{type:'active',activeFlags:[]}};
      let result;
      if(p.tool==='list_threads')result={threads:[thread],pinnedThreads:[],sections:[['progress','In Progress'],['review','For Review'],['later','For Later']].map(([sectionId,name])=>({sectionId,name,itemKeys:sectionId===section?['codex:thread:local:test']:[]}))};
      else if(p.tool==='read_thread')result={thread};
      else if(p.tool==='move_thread_to_sidebar_section'){section=p.arguments.sectionId;result=p.arguments;}
      else process.exit(8);
      send({id:m.id,result:{content:[{type:'text',text:JSON.stringify(result)}]}});
    });`;
  const child = spawn(process.execPath, [script, '-e', server, 'app-server'], {
    env: { ...process.env, SIDEBAR_FLOW_REAL_CODEX: process.execPath, SIDEBAR_FLOW_CONFIG_FILE: config },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); child.stdin.destroy(); await rm(root, { recursive: true, force: true }); });
  child.stdout.resume();
  const moved = new Promise((resolve, reject) => {
    let stderr = '';
    child.once('error', reject); child.once('close', () => reject(Error('Proxy exited before movement')));
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk;
      if (stderr.includes('"action":"moved"')) resolve();
    });
  });
  child.stdin.write(JSON.stringify({ id: 1, method: 'initialize' }) + '\n');
  await moved;
  const text = await readFile(join(root, 'timings.jsonl'), 'utf8');
  const timing = JSON.parse(text);
  assert.equal(timing.threadId, 'test');
  assert.equal(timing.action, 'moved');
  assert.equal(timing.rpcCounts.list_threads, 3);
  assert.ok(timing.queueMs >= 0 && timing.executionMs > 0);
  assert.ok(!text.includes('PRIVATE_EVENT'));
  const closed = once(child, 'close'); child.stdin.end();
  assert.equal((await closed)[0], 0);
});
test('installed-mode proxy starts compensation without lifecycle events or model turns', { timeout: 12000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidebar-timer-'));
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, mode: 'all-local' }));
  const server = `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const m = JSON.parse(line);
    if (!['initialize', 'thread/loaded/list'].includes(m.method)) process.exit(9);
    process.stdout.write(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{data:[],nextCursor:null}})+'\\n');
  });`;
  const child = spawn(process.execPath, [script, '-e', server, 'app-server'], {
    env: { ...process.env, SIDEBAR_FLOW_REAL_CODEX: process.execPath, SIDEBAR_FLOW_CONFIG_FILE: config },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); child.stdin.destroy(); await rm(root, { recursive: true, force: true }); });
  child.stdout.resume();
  const diagnostic = new Promise((resolve, reject) => {
    let stderr = '';
    child.once('error', reject); child.once('close', () => reject(Error('No timer diagnostic before exit')));
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk;
      if (stderr.includes('no-native-context')) resolve(stderr);
    });
  });
  child.stdin.write(JSON.stringify({ id: 1, method: 'initialize' }) + '\n');
  assert.match(await diagnostic, /reconciliation/);
  const closed = once(child, 'close'); child.stdin.end();
  assert.equal((await closed)[0], 0);
});
test('CLI proxy drains final server responses after client EOF', () => {
  const server = `let input = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      const request = JSON.parse(input);
      process.stdout.write(JSON.stringify({ id: request.id, result: 'final' }) + '\\n');
      process.stdout.write(JSON.stringify({ method: 'server/shutdown' }) + '\\n');
    });`;
  const result = spawnSync(process.execPath, [script, '-e', server, 'app-server'], {
    env: { ...process.env, SIDEBAR_FLOW_REAL_CODEX: process.execPath, SIDEBAR_FLOW_TEST_THREADS: '["test"]' },
    input: JSON.stringify({ id: 17, method: 'initialize', params: {} }) + '\n',
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, JSON.stringify({ id: 17, result: 'final' }) + '\n'
    + JSON.stringify({ method: 'server/shutdown' }) + '\n');
});
test('CLI proxy preserves Unicode separators inside JSON strings', { timeout: 5000 }, async () => {
  const payload = { id: 1, result: { text: 'x'.repeat(45000) + '\u2028优先从第一性原理出发\u2029末尾' } };
  const server = `process.stdout.write(${JSON.stringify(JSON.stringify(payload) + '\n')});`;
  const child = spawn(process.execPath, [script, '-e', server, 'app-server'], {
    env: { ...process.env, SIDEBAR_FLOW_REAL_CODEX: process.execPath, SIDEBAR_FLOW_TEST_THREADS: '["test"]' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  try {
    const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    assert.equal(code, 0, stderr);
    assert.ok(stdout === JSON.stringify(payload) + '\n', 'one JSON frame must remain one LF-delimited line');
  } finally { child.kill(); child.stdin.destroy(); }
});
test('CLI proxy preserves non-server arguments and output', () => {
  const result = spawnSync(process.execPath, [script, '--version'], {
    env: { ...process.env, SIDEBAR_FLOW_REAL_CODEX: process.execPath }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.version);
});
test('CLI proxy preserves multiple UTF-8 JSON frames in both directions', { timeout: 5000 }, async t => {
  const frames = [
    { method: 'test/notification', params: { text: '头\u2028中\u2029尾'.repeat(10000) } },
    { method: 'test/notification', params: { text: 'second\r\nline' } },
  ];
  const wire = frames.map(frame => JSON.stringify(frame) + '\n').join('');
  const child = spawn(process.execPath, [script, '-e', 'process.stdin.pipe(process.stdout)', 'app-server'], {
    env: { ...process.env, SIDEBAR_FLOW_REAL_CODEX: process.execPath, SIDEBAR_FLOW_TEST_THREADS: '["test"]' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { child.kill(); child.stdin.destroy(); });
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  const received = new Promise((resolve, reject) => {
    let output = '';
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length >= wire.length) resolve(output);
    });
    child.once('close', () => reject(Error('Proxy closed before the complete response')));
  });
  const bytes = Buffer.from(wire);
  for (let offset = 0; offset < bytes.length; offset += 8191) child.stdin.write(bytes.subarray(offset, offset + 8191));
  assert.ok(await received === wire, 'UTF-8 content and frame boundaries must round-trip exactly');
});
test('CLI proxy refuses missing executable and unscoped app-server startup', () => {
  const env = { ...process.env }; delete env.SIDEBAR_FLOW_REAL_CODEX;
  const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SIDEBAR_PROXY_CONFIG_ERROR/);
  assert.equal(result.stdout, '');
  const unscoped = spawnSync(process.execPath, [script, 'app-server'], {
    env: { ...env, SIDEBAR_FLOW_REAL_CODEX: process.execPath, SIDEBAR_FLOW_TEST_THREADS: '[]' }, encoding: 'utf8',
  });
  assert.equal(unscoped.status, 1);
  assert.match(unscoped.stderr, /SIDEBAR_PROXY_CONFIG_ERROR/);
});
