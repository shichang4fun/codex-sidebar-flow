#!/usr/bin/env node
// CLI wrapper used by the opt-in Desktop installation and isolated protocol lab.
import { spawn } from 'node:child_process';
import { realpathSync, readFileSync } from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStdioRelay } from './stdio-relay.mjs';
import { createObserver } from './app-server-observer.mjs';
import { desktopMcpAdapter } from './desktop-mcp-adapter.mjs';
import { createDesktopObserverManager } from './desktop-observer-manager.mjs';
import { startReconciliation } from './desktop-reconciliation-timer.mjs';
import { createTimingWriter } from './desktop-timing.mjs';

// JSONL is delimited by ASCII LF, not Unicode line/paragraph separators.
// Node readline also splits those valid JSON string characters in this runtime.
function readJsonLines(stream, onLine) {
  let buffer = '', scanned = 0;
  stream.setEncoding('utf8'); // Preserve characters split across pipe chunks.
  const data = chunk => {
    buffer += chunk;
    let start = 0, end;
    while ((end = buffer.indexOf('\n', scanned)) !== -1) {
      onLine(buffer.slice(start, end));
      start = end + 1;
      scanned = start;
    }
    buffer = buffer.slice(start);
    scanned = buffer.length;
  };
  const end = () => { if (buffer) onLine(buffer); buffer = ''; };
  stream.on('data', data);
  stream.once('end', end);
  return () => { stream.off('data', data); stream.off('end', end); stream.pause(); };
}

function main() {
  const executable = process.env.SIDEBAR_FLOW_REAL_CODEX;
  if (!executable || !isAbsolute(executable) || realpathSync(executable) === realpathSync(fileURLToPath(import.meta.url))) {
    throw Error('Invalid executable');
  }
  const args = process.argv.slice(2);
  const index = args.indexOf('app-server');
  const isServer = index >= 0 && !['daemon', 'proxy', 'generate-ts', 'generate-json-schema'].includes(args[index + 1])
    && !args.includes('--help') && !args.includes('-h');
  let threadIds = [], excluded = [];
  const configFile = process.env.SIDEBAR_FLOW_CONFIG_FILE;
  if (isServer) {
    if (configFile) {
      if (!isAbsolute(configFile)) throw Error('Absolute configuration path required');
    } else {
      threadIds = JSON.parse(process.env.SIDEBAR_FLOW_TEST_THREADS ?? '[]');
      excluded = JSON.parse(process.env.SIDEBAR_FLOW_EXCLUDE_THREADS ?? '[]');
      createObserver({}, { threadIds, excludeThreadIds: excluded });
      if (!Array.isArray(excluded) || excluded.some(id => typeof id !== 'string')) throw Error('Invalid exclusions');
    }
    const listen = args.findIndex(arg => arg === '--listen');
    if ((listen >= 0 && args[listen + 1] !== 'stdio://') || args.some(arg => arg.startsWith('--listen='))) {
      throw Error('Stdio transport required');
    }
  }
  const env = { ...process.env, CODEX_CLI_PATH: executable };
  for (const key of Object.keys(env)) if (key.startsWith('SIDEBAR_FLOW_')) delete env[key];
  const child = spawn(executable, args, { env, stdio: isServer ? ['pipe', 'pipe', 'inherit'] : 'inherit' });
  const signal = name => {
    child.kill(name);
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000); timer.unref();
  };
  process.once('SIGTERM', () => signal('SIGTERM'));
  process.once('SIGINT', () => signal('SIGINT'));
  child.once('error', () => { process.stderr.write('SIDEBAR_PROXY_CHILD_FAILED\n'); process.exitCode = 1; });
  child.once('close', (code, signalName) => { process.exitCode = code ?? (signalName ? 1 : 0); });
  if (!isServer) return;

  const incoming = process.stdin;
  const outgoing = child.stdout;
  function write(stream, source, value) {
    if (!stream.write(JSON.stringify(value) + '\n')) {
      source.pause(); stream.once('drain', () => source.resume());
    }
  }
  const relay = createStdioRelay({
    toServer: value => write(child.stdin, incoming, value),
    toDesktop: value => write(process.stdout, outgoing, value),
  });
  const observers = new Map(threadIds.filter(id => !excluded.includes(id)).map(id => [id,
    createObserver(desktopMcpAdapter(relay, id), { threadIds: [id], apply: process.env.SIDEBAR_FLOW_APPLY_TEST_ONLY === '1' }),
  ]));
  const log = value => process.stderr.write(JSON.stringify({ sidebarFlow: value }) + '\n');
  const manager = configFile ? createDesktopObserverManager(relay, {
    readConfig: () => JSON.parse(readFileSync(configFile, 'utf8')),
    onRetry: result => log({ event: 'startup-retry', ...result }),
    onTiming: createTimingWriter(dirname(configFile)),
  }) : null;
  const stopReconciliation = manager ? startReconciliation(manager, {
    readConfig: () => JSON.parse(readFileSync(configFile, 'utf8')), log,
  }) : () => {};
  relay.subscribe(message => {
    if (manager) {
      return manager.handle(message).then(result => {
        if (result.action !== 'skipped') log({ event: message.method, ...result });
      }, () => log({ error: 'OBSERVER_FAILED' }));
    }
    const id = message.method === 'thread/started' ? message.params?.thread?.id : message.params?.threadId;
    const observer = observers.get(id);
    if (!observer || !['thread/started', 'thread/status/changed', 'turn/started', 'turn/completed'].includes(message.method)) return;
    return observer.handle(message).then(result => log({ event: message.method, ...result }), () => log({ error: 'OBSERVER_FAILED' }));
  });
  const stopIncoming = readJsonLines(incoming, line => {
    let message;
    try { message = JSON.parse(line); } catch { child.stdin.write(line + '\n'); return; }
    relay.fromDesktop(message);
  });
  const stopOutgoing = readJsonLines(outgoing, line => {
    let message;
    try { message = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }
    relay.fromServer(message);
  });
  incoming.once('end', () => { stopReconciliation(); manager?.stop(); relay.stopObserving(); child.stdin.end(); });
  child.stdin.on('error', () => { stopReconciliation(); manager?.stop(); relay.stopObserving(); });
  process.stdout.on('error', () => { stopReconciliation(); manager?.stop(); relay.close(); child.kill(); });
  child.once('close', () => { stopReconciliation(); manager?.stop(); relay.close(); stopIncoming(); stopOutgoing(); });
}

try { main(); }
catch { process.stderr.write('SIDEBAR_PROXY_CONFIG_ERROR\n'); process.exitCode = 1; }
