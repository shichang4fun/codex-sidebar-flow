#!/usr/bin/env node
// Optional, per-user GUI startup integration. Does not edit or launch Codex.
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const OWNER = 'codex-sidebar-flow-original-icon-v1';
const DESKTOP_OWNER = 'codex-sidebar-flow-desktop-v1';
const LABEL = 'io.github.codex-sidebar-flow.original-icon';
const source = fileURLToPath(import.meta.url);
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const validPath = s => typeof s === 'string' && path.isAbsolute(s)
  && path.resolve(s) === s && !/[\x00-\x1f\x7f]/.test(s);
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 10000,
  stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function context({ homeDir = os.homedir() }, deps) {
  const system = { run, platform: process.platform, uid: process.getuid?.(), ...deps };
  if (system.platform !== 'darwin') throw Error('Original-icon integration requires macOS');
  if (!validPath(homeDir) || homeDir === '/' || !Number.isInteger(system.uid) || system.uid === 0) {
    throw Error('A non-root GUI user and absolute home directory are required');
  }
  const support = path.join(homeDir, 'Library/Application Support/Codex Sidebar Flow Original Icon');
  return { homeDir, support, system, domain: `gui/${system.uid}`, job: `gui/${system.uid}/${LABEL}`,
    shim: path.join(support, 'codex-original-icon'), state: path.join(support, 'installation.json'),
    helper: path.join(support, 'original-icon.mjs'),
    plist: path.join(homeDir, 'Library/LaunchAgents', `${LABEL}.plist`) };
}
async function stat(file) {
  try { return await lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function regular(file) {
  if (!(await stat(file))?.isFile()) throw Error('Unsafe or missing integration file');
  return readFile(file, 'utf8');
}
async function privateDirectory(dir) {
  const s = await stat(dir);
  if (!s?.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077)) throw Error('Unsafe private directory');
}
async function parents(c, target) {
  // Check each user-relative ancestor; never follow a symlink into another tree.
  let dir = c.homeDir;
  for (const part of ['', ...path.relative(c.homeDir, target).split(path.sep)]) {
    dir = path.join(dir, part);
    const s = await stat(dir);
    if (s && !s.isDirectory()) throw Error('Unsafe integration parent');
    if (!s) await mkdir(dir, { mode: 0o700 });
  }
}
async function atomic(file, content, mode = 0o600) {
  const s = await stat(file);
  if (s && !s.isFile()) throw Error('Unsafe integration file');
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, content, { flag: 'wx', mode });
  await rename(temp, file);
}
function plistContent(c, nodePath) {
  const args = [nodePath, c.helper, '--refresh', '--home', c.homeDir];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map(s => `<string>${xml(s)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>LimitLoadToSessionType</key><string>Aqua</string>
</dict></plist>\n`;
}
async function readOwned(c) {
  await privateDirectory(c.support);
  if (await regular(path.join(c.support, '.owner')) !== OWNER) throw Error('Unowned integration directory');
  const state = JSON.parse(await regular(c.state));
  if (state.owner !== OWNER || ![state.root, state.nodePath, state.realCodex].every(validPath)) {
    throw Error('Invalid integration manifest');
  }
  return state;
}
async function checkPlist(c, state, file = c.plist) {
  if (await stat(file) && await regular(file) !== plistContent(c, state.nodePath)) {
    throw Error('Foreign or modified LaunchAgent; refusing overwrite');
  }
}
function checkOverride(c) {
  const current = c.system.run('/bin/launchctl', ['getenv', 'CODEX_CLI_PATH']);
  if (current && current !== c.shim) throw Error('Conflicting CODEX_CLI_PATH override; left unchanged');
}
function loaded(c, state) {
  let output;
  try { output = c.system.run('/bin/launchctl', ['print', c.job]); } catch { return false; }
  // The on-disk plist is not proof of what launchd previously registered.
  // Unknown print formats fail closed; never adopt/bootout a same-label job.
  const registeredPath = output.match(/^\tpath = (.*)$/m)?.[1];
  const program = output.match(/^\tprogram = (.*)$/m)?.[1];
  const args = output.match(/^\targuments = \{\n([\s\S]*?)^\t\}/m)?.[1]
    .split('\n').filter(Boolean).map(line => line.replace(/^\t\t/, ''));
  const expected = [state.nodePath, c.helper, '--refresh', '--home', c.homeDir];
  if (registeredPath !== c.plist || program !== state.nodePath || JSON.stringify(args) !== JSON.stringify(expected)) {
    throw Error('Foreign or unrecognized registered LaunchAgent; left unchanged');
  }
  return true;
}

export async function refreshOriginalIcon(options = {}, deps = {}) {
  const c = context(options, deps);
  const state = await readOwned(c);
  await checkPlist(c, state);
  if (!await stat(c.plist)) throw Error('Original-icon integration is disabled');
  await regular(c.shim);
  checkOverride(c);
  c.system.run('/bin/launchctl', ['setenv', 'CODEX_CLI_PATH', c.shim]);
  return { enabled: true, restartRequired: true };
}

export async function installOriginalIcon(options, deps = {}) {
  const c = context(options, deps);
  const { root } = options;
  if (!validPath(root) || root === c.support || c.support.startsWith(`${root}/`)) throw Error('Unsafe installation root');
  await privateDirectory(root);
  const manifest = JSON.parse(await regular(path.join(root, 'installation.json')));
  if (await regular(path.join(root, '.owner')) !== DESKTOP_OWNER || manifest.owner !== DESKTOP_OWNER
      || manifest.proxy !== path.join(root, 'codex-proxy')
      || ![manifest.nodePath, manifest.realCodex].every(validPath)) throw Error('Invalid Desktop installation');
  for (const file of [manifest.nodePath, manifest.realCodex, manifest.proxy]) {
    const s = await stat(file);
    if (!s?.isFile() || !(s.mode & 0o111)) throw Error('Unsafe or non-executable installation file');
  }
  await regular(path.join(root, 'config.json'));
  checkOverride(c);
  const state = { owner: OWNER, root, nodePath: manifest.nodePath, realCodex: manifest.realCodex };
  const existing = await stat(c.support) ? await readOwned(c) : null;
  if (existing && JSON.stringify(existing) !== JSON.stringify(state)) {
    throw Error('Integration targets another installation; disable and inspect before changing paths');
  }
  await checkPlist(c, state);
  await checkPlist(c, state, `${c.plist}.disabled`);
  loaded(c, state);
  await parents(c, path.dirname(c.support));
  await parents(c, path.dirname(c.plist));
  if (!existing) {
    await mkdir(c.support, { mode: 0o700 });
    await writeFile(path.join(c.support, '.owner'), OWNER, { flag: 'wx', mode: 0o600 });
  }
  const shim = `#!/bin/sh
proxy=${quote(manifest.proxy)}
config=${quote(path.join(root, 'config.json'))}
real_codex=${quote(manifest.realCodex)}
if [ -x "$proxy" ] && [ -f "$config" ]; then exec "$proxy" "$@"; fi
export CODEX_CLI_PATH="$real_codex"
exec "$real_codex" "$@"
`;
  await atomic(c.state, JSON.stringify(state, null, 2) + '\n');
  await atomic(c.shim, shim, 0o700);
  // A standalone copy keeps disable/login refresh usable without this checkout.
  await atomic(c.helper, await readFile(source));
  await atomic(path.join(c.support, 'Disable Original Icon Integration.command'),
    `#!/bin/sh\nexec ${quote(manifest.nodePath)} ${quote(c.helper)} --disable --home ${quote(c.homeDir)}\n`, 0o700);
  await atomic(c.plist, plistContent(c, manifest.nodePath));
  if (!loaded(c, state)) c.system.run('/bin/launchctl', ['bootstrap', c.domain, c.plist]);
  await refreshOriginalIcon(options, deps);
  return { shim: c.shim, plist: c.plist, restartRequired: true, lifecycleVerified: false };
}

export async function disableOriginalIcon(options = {}, deps = {}) {
  const c = context(options, deps);
  const state = await readOwned(c);
  await checkPlist(c, state);
  await checkPlist(c, state, `${c.plist}.disabled`);
  const registered = loaded(c, state);
  // Remove RunAtLoad registration first, stop any in-flight refresh, then unset.
  if (await stat(c.plist)) await rename(c.plist, `${c.plist}.disabled`);
  if (registered) c.system.run('/bin/launchctl', ['bootout', c.job]);
  if (c.system.run('/bin/launchctl', ['getenv', 'CODEX_CLI_PATH']) === c.shim) {
    c.system.run('/bin/launchctl', ['unsetenv', 'CODEX_CLI_PATH']);
  }
  return { disabled: true, filesPreserved: true, restartRequired: true };
}

if (process.argv[1] && realpathSync(source) === realpathSync(process.argv[1])) {
  try {
    const { values } = parseArgs({ options: { root: { type: 'string' }, home: { type: 'string' },
      disable: { type: 'boolean' }, refresh: { type: 'boolean' } } });
    if (values.disable && values.refresh) throw Error('Choose either disable or refresh');
    const action = values.disable ? disableOriginalIcon : values.refresh ? refreshOriginalIcon : installOriginalIcon;
    const result = await action({ root: values.root, homeDir: values.home });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(`ORIGINAL_ICON_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  }
}
