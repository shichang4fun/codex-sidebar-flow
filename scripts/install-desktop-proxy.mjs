#!/usr/bin/env node
import { lstat, mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateProxyConfig } from '../experimental/desktop-proxy-config.mjs';
import { acquireDesktopLock } from './desktop-proxy-lock.mjs';

const OWNER = 'codex-sidebar-flow-desktop-v1';
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const files = ['experimental/stdio-observer-proxy.mjs', 'experimental/stdio-relay.mjs',
  'experimental/app-server-observer.mjs', 'experimental/desktop-mcp-adapter.mjs',
  'experimental/desktop-proxy-config.mjs', 'experimental/desktop-observer-manager.mjs',
  'experimental/desktop-reconciliation-timer.mjs',
  'experimental/desktop-timing.mjs',
  'scripts/sidebar-policy.mjs', 'scripts/launch-desktop-proxy.mjs', 'scripts/desktop-proxy-lock.mjs',
  'scripts/install-desktop-proxy.mjs'];
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const validPath = value => typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);

async function stat(file) {
  try { return await lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function ownedRoot(root, create = false) {
  if (!validPath(root) || path.resolve(root) !== root || root.split(path.sep).filter(Boolean).length < 3) {
    throw Error('A dedicated absolute installation directory is required');
  }
  const s = await stat(root);
  if (!s && create) {
    await mkdir(root, { mode: 0o700 });
    await writeFile(path.join(root, '.owner'), OWNER, { flag: 'wx', mode: 0o600 });
    return;
  }
  if (!s?.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0) throw Error('Unsafe installation directory');
  const marker = path.join(root, '.owner');
  if (!(await stat(marker))?.isFile() || await readFile(marker, 'utf8') !== OWNER) throw Error('Unowned installation directory');
}
async function atomic(file, data, mode = 0o600) {
  const current = await stat(file);
  if (current && !current.isFile()) throw Error('Refusing non-regular installation file');
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, data, { mode, flag: 'wx' });
  await rename(temp, file);
}
async function directory(dir) {
  const s = await stat(dir);
  if (s && (!s.isDirectory() || s.isSymbolicLink())) throw Error('Unsafe installation subdirectory');
  if (!s) await mkdir(dir, { mode: 0o700 });
}

export async function installDesktopProxy({ root, nodePath, appPath, realCodex, config }) {
  if (![nodePath, appPath, realCodex].every(validPath)) throw Error('Explicit app, Node and Codex paths required');
  for (const executable of [nodePath, realCodex]) {
    if (!(await lstat(executable)).isFile()) throw Error('Executable is not a regular file');
  }
  const initial = validateProxyConfig(config);
  // Read the complete runtime before creating or modifying the installation.
  const content = await Promise.all(files.map(f => readFile(path.join(sourceRoot, f))));
  const hash = createHash('sha256');
  files.forEach((f, i) => { hash.update(f); hash.update(content[i]); });
  const release = hash.digest('hex');
  await ownedRoot(root, true);
  const releaseLock = await acquireDesktopLock(root);
  try {
    const releases = path.join(root, 'releases'); await directory(releases);
    const runtime = path.join(releases, release);
    if (!await stat(runtime)) {
      const stage = path.join(releases, `.stage-${randomUUID()}`); await directory(stage);
      for (let i = 0; i < files.length; i++) {
        await directory(path.join(stage, path.dirname(files[i])));
        await writeFile(path.join(stage, files[i]), content[i], { flag: 'wx', mode: 0o600 });
      }
      await rename(stage, runtime);
    } else {
      await directory(runtime);
      for (let i = 0; i < files.length; i++) {
        const file = path.join(runtime, files[i]);
        if (!(await stat(file))?.isFile() || !(await readFile(file)).equals(content[i])) throw Error('Existing release differs');
      }
    }
    const configPath = path.join(root, 'config.json');
    if (!await stat(configPath)) await atomic(configPath, JSON.stringify(initial, null, 2) + '\n');
    else {
      if (!(await stat(configPath)).isFile()) throw Error('Unsafe configuration file');
      validateProxyConfig(JSON.parse(await readFile(configPath, 'utf8')));
    }
    const proxy = path.join(root, 'codex-proxy');
    await atomic(proxy, `#!/bin/sh\nexport SIDEBAR_FLOW_REAL_CODEX=${quote(realCodex)}\nexport SIDEBAR_FLOW_CONFIG_FILE=${quote(configPath)}\nexec ${quote(nodePath)} ${quote(path.join(runtime, files[0]))} "$@"\n`, 0o700);
    const manifest = { owner: OWNER, release, nodePath, appPath, realCodex, proxy };
    await atomic(path.join(root, 'installation.json'), JSON.stringify(manifest, null, 2) + '\n');
    const launcher = path.join(root, 'Launch Codex Sidebar Flow.command');
    const launch = `#!/bin/sh\nexec ${quote(nodePath)} ${quote(path.join(runtime, 'scripts/launch-desktop-proxy.mjs'))} --root ${quote(root)} "$@"\n`;
    await atomic(launcher, launch, 0o700);
    await atomic(path.join(root, 'Uninstall Codex Sidebar Flow.command'),
      `#!/bin/sh\nexec ${quote(nodePath)} ${quote(path.join(runtime, 'scripts/install-desktop-proxy.mjs'))} --root ${quote(root)} --uninstall\n`, 0o700);
    const app = path.join(root, 'Codex Sidebar Flow.app');
    for (const dir of [app, path.join(app, 'Contents'), path.join(app, 'Contents/MacOS')]) await directory(dir);
    await atomic(path.join(app, 'Contents/MacOS/launcher'), launch, 0o700);
    await atomic(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.github.codex-sidebar-flow.launcher</string><key>CFBundleName</key><string>Codex Sidebar Flow</string><key>CFBundleExecutable</key><string>launcher</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>\n`);
    return { root, launcher, app, release, activated: false };
  } finally { await releaseLock(); }
}

export async function uninstallDesktopProxy({ root }) {
  await ownedRoot(root);
  const releaseLock = await acquireDesktopLock(root);
  try {
    // Moving the directory makes the running manager's config path unavailable,
    // so its per-operation policy check fails closed. Preserve original config.
    const backup = `${root}.uninstalled-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await rename(root, backup);
    await unlink(path.join(backup, '.launch-lock'));
    return { backup, removedPermanently: false, restartCodexNormally: true };
  } finally { await releaseLock(); }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const { values } = parseArgs({ options: {
    root: { type: 'string' }, node: { type: 'string' }, app: { type: 'string' }, codex: { type: 'string' },
    exclude: { type: 'string', multiple: true }, uninstall: { type: 'boolean', default: false },
  } });
  const work = values.uninstall ? uninstallDesktopProxy({ root: values.root }) : installDesktopProxy({
    root: values.root, nodePath: values.node, appPath: values.app, realCodex: values.codex,
    config: { version: 1, mode: 'all-local', excludedThreadIds: values.exclude ?? [] },
  });
  work.then(r => process.stdout.write(JSON.stringify(r) + '\n'), () => {
    process.stderr.write('DESKTOP_INSTALL_FAILED: check dedicated directory, paths and ownership\n'); process.exitCode = 1;
  });
}
