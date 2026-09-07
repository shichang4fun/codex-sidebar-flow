#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { acquireDesktopLock } from './desktop-proxy-lock.mjs';

const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 5000,
  stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function processes() {
  return run('/bin/ps', ['-axo', 'pid=,ppid=,args=']).split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }] : [];
  });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function launchDesktopProxy({ root, waitForQuit = false }, deps = {}) {
  const system = { run, processes, sleep, ...deps };
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw Error('Absolute installation root required');
  const s = await lstat(root);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0) throw Error('Unsafe installation root');
  const owner = await readFile(path.join(root, '.owner'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(root, 'installation.json'), 'utf8'));
  if (owner !== 'codex-sidebar-flow-desktop-v1' || manifest.owner !== owner
      || !/^[a-f0-9]{64}$/.test(manifest.release) || !path.isAbsolute(manifest.appPath)
      || manifest.proxy !== path.join(root, 'codex-proxy')) throw Error('Invalid installation');
  const executable = system.run('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-',
    path.join(manifest.appPath, 'Contents/Info.plist')]);
  if (!/^[a-zA-Z0-9 ._-]+$/.test(executable)) throw Error('Invalid application executable');
  const app = path.join(manifest.appPath, 'Contents/MacOS', executable);
  const entry = path.join(root, 'releases', manifest.release, 'experimental/stdio-observer-proxy.mjs');
  const desktop = rows => rows.filter(p => p.args === app);
  const proxy = rows => rows.find(p => desktop(rows).some(a => p.ppid === a.pid)
    && p.args.includes(entry) && p.args.includes('app-server'));
  async function save(phase, details = {}) {
    const result = { phase, at: new Date().toISOString(), ...details };
    const tmp = path.join(root, `.status-${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(tmp, path.join(root, 'launch-status.json'));
    return result;
  }
  const releaseLock = await acquireDesktopLock(root);
  try {
    let rows = system.processes();
    if (proxy(rows)) return await save('proxy-attached', { proxyPid: proxy(rows).pid, alreadyRunning: true });
    if (desktop(rows).length && !waitForQuit) return await save('restart-required');
    if (desktop(rows).length) {
      await save('waiting-for-user-quit', { timeoutSeconds: 1800 });
      for (let n = 0; n < 3600 && desktop(rows).length; n++) {
        await system.sleep(500); rows = system.processes();
      }
      if (desktop(rows).length) return await save('manual-quit-timeout');
    }
    // Explicit per-launch environment: no launchctl globals, signed-app changes,
    // forced termination, remote setup or old lifecycle instructions.
    if (await readFile(path.join(root, '.owner'), 'utf8') !== owner
        || !(await lstat(manifest.proxy)).isFile()) throw Error('Installation changed before launch');
    system.run('/usr/bin/open', ['--env', `CODEX_CLI_PATH=${manifest.proxy}`, '-a', manifest.appPath]);
    await save('launching');
    for (let n = 0; n < 60; n++) {
      rows = system.processes();
      const attached = proxy(rows);
      if (attached) {
        await system.sleep(1500);
        if (proxy(system.processes())?.pid === attached.pid) {
          return await save('proxy-attached', { proxyPid: attached.pid, desktopPid: attached.ppid, lifecycleVerified: false });
        }
      }
      await system.sleep(500);
    }
    return await save('proxy-not-detected');
  } finally {
    await releaseLock();
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const { values } = parseArgs({ options: { root: { type: 'string' }, 'wait-for-quit': { type: 'boolean', default: false } } });
  launchDesktopProxy({ root: values.root, waitForQuit: values['wait-for-quit'] }).then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.phase !== 'proxy-attached') process.exitCode = 2;
  }, () => { process.stderr.write('DESKTOP_LAUNCH_FAILED: inspect installation and launcher lock\n'); process.exitCode = 1; });
}
