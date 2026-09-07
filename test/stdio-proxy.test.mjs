import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../experimental/stdio-observer-proxy.mjs', import.meta.url));
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
