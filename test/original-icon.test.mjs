import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const url = new URL('../scripts/original-icon.mjs', import.meta.url);
test('portable original-icon installer is available', () => assert.ok(existsSync(url)));

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sidebar-icon-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const homeDir = path.join(temp, "user ' & home");
  const root = path.join(homeDir, 'Applications/Sidebar Flow');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const realCodex = path.join(temp, 'real-codex');
  await writeFile(realCodex, '#!/bin/sh\nprintf "real:%s\\n" "$@"\n', { mode: 0o700 });
  await writeFile(path.join(root, 'codex-proxy'), '#!/bin/sh\nprintf "proxy:%s\\n" "$@"\n', { mode: 0o700 });
  await writeFile(path.join(root, 'config.json'), '{}');
  await writeFile(path.join(root, '.owner'), 'codex-sidebar-flow-desktop-v1');
  await writeFile(path.join(root, 'installation.json'), JSON.stringify({
    owner: 'codex-sidebar-flow-desktop-v1', nodePath: process.execPath,
    realCodex, proxy: path.join(root, 'codex-proxy'),
  }));
  const support = path.join(homeDir, 'Library/Application Support/Codex Sidebar Flow Original Icon');
  const agent = path.join(homeDir, 'Library/LaunchAgents/io.github.codex-sidebar-flow.original-icon.plist');
  const state = { env: '', loaded: false, calls: [], failBootstrap: false, foreign: false };
  const deps = { platform: 'darwin', uid: 501, run(bin, args) {
    assert.equal(bin, '/bin/launchctl');
    state.calls.push(args);
    switch (args[0]) {
      case 'getenv': return state.env;
      case 'setenv': state.env = args[2]; return '';
      case 'unsetenv': state.env = ''; return '';
      case 'print':
        if (!state.loaded) throw Error('not loaded');
        return `gui/501/io.github.codex-sidebar-flow.original-icon = {\n\tpath = ${agent}\n\tprogram = ${state.foreign ? '/other/program' : process.execPath}\n\targuments = {\n\t\t${process.execPath}\n\t\t${path.join(support, 'original-icon.mjs')}\n\t\t--refresh\n\t\t--home\n\t\t${homeDir}\n\t}\n}`;
      case 'bootstrap': if (state.failBootstrap) throw Error('bootstrap failure'); state.loaded = true; return '';
      case 'bootout': state.loaded = false; return '';
      default: throw Error('unexpected command');
    }
  } };
  return { homeDir, root, state, deps };
}

test('install is idempotent; real shim preserves arguments and falls back after proxy uninstall', async t => {
  if (!existsSync(url)) return;
  const { installOriginalIcon } = await import(url);
  const f = await fixture(t);
  const result = await installOriginalIcon(f, f.deps);
  assert.equal(result.restartRequired, true);
  assert.equal(f.state.env, result.shim);
  const args = ['app-server', "space ' quote", '$(literal)'];
  assert.equal(execFileSync(result.shim, args, { encoding: 'utf8' }), args.map(a => `proxy:${a}\n`).join(''));
  const config = await readFile(path.join(f.root, 'config.json'), 'utf8');
  await installOriginalIcon(f, f.deps);
  assert.equal(f.state.calls.filter(a => a[0] === 'bootstrap').length, 1);
  assert.equal(await readFile(path.join(f.root, 'config.json'), 'utf8'), config);
  const plist = await readFile(result.plist, 'utf8');
  assert.match(plist, /&amp;/);
  assert.match(plist, /RunAtLoad/);
  assert.doesNotMatch(plist, /KeepAlive/);
  if (process.platform === 'darwin') execFileSync('/usr/bin/plutil', ['-lint', result.plist]);
  await rm(path.join(f.root, 'config.json'));
  assert.equal(execFileSync(result.shim, args, { encoding: 'utf8' }), args.map(a => `real:${a}\n`).join(''));
});

test('conflicting GUI override is preserved before any install or refresh writes', async t => {
  if (!existsSync(url)) return;
  const { installOriginalIcon, refreshOriginalIcon } = await import(url);
  const f = await fixture(t);
  f.state.env = '/other/cli';
  await assert.rejects(installOriginalIcon(f, f.deps), /override/i);
  assert.equal(f.state.env, '/other/cli');
  assert.equal(existsSync(path.join(f.homeDir, 'Library/Application Support/Codex Sidebar Flow Original Icon')), false);
  f.state.env = '';
  await installOriginalIcon(f, f.deps);
  f.state.env = '/other/cli';
  await assert.rejects(refreshOriginalIcon(f, f.deps), /override/i);
  assert.equal(f.state.env, '/other/cli');
});

test('disable is repeatable, preserves files and other overrides, and refresh will not reenable it', async t => {
  if (!existsSync(url)) return;
  const { installOriginalIcon, disableOriginalIcon, refreshOriginalIcon } = await import(url);
  const f = await fixture(t);
  const installed = await installOriginalIcon(f, f.deps);
  await disableOriginalIcon(f, f.deps);
  assert.equal(f.state.env, '');
  assert.equal(f.state.loaded, false);
  assert.equal(existsSync(installed.plist), false);
  assert.ok(existsSync(`${installed.plist}.disabled`));
  assert.ok(existsSync(installed.shim));
  assert.ok(existsSync(path.join(f.root, 'config.json')));
  await assert.rejects(refreshOriginalIcon(f, f.deps), /disabled/i);
  await disableOriginalIcon(f, f.deps);
  await installOriginalIcon(f, f.deps);
  f.state.env = '/other/cli';
  await disableOriginalIcon(f, f.deps);
  assert.equal(f.state.env, '/other/cli');
});

test('refuses unowned support directories, foreign plist and symlink installation roots', async t => {
  if (!existsSync(url)) return;
  const { installOriginalIcon } = await import(url);
  const f = await fixture(t);
  const support = path.join(f.homeDir, 'Library/Application Support/Codex Sidebar Flow Original Icon');
  await mkdir(support, { recursive: true });
  await writeFile(path.join(support, 'personal.txt'), 'keep');
  await assert.rejects(installOriginalIcon(f, f.deps), /owned|unsafe/i);
  assert.equal(await readFile(path.join(support, 'personal.txt'), 'utf8'), 'keep');
  await rm(support, { recursive: true });
  const agentDir = path.join(f.homeDir, 'Library/LaunchAgents');
  await mkdir(agentDir, { recursive: true });
  const plist = path.join(agentDir, 'io.github.codex-sidebar-flow.original-icon.plist');
  await writeFile(plist, 'foreign');
  await assert.rejects(installOriginalIcon(f, f.deps), /owned|foreign/i);
  assert.equal(await readFile(plist, 'utf8'), 'foreign');
  await rm(plist);
  const linked = path.join(f.homeDir, 'linked');
  await symlink(f.root, linked);
  await assert.rejects(installOriginalIcon({ ...f, root: linked }, f.deps), /unsafe/i);
});

test('bootstrap failure does not change GUI environment and can be retried', async t => {
  if (!existsSync(url)) return;
  const { installOriginalIcon } = await import(url);
  const f = await fixture(t);
  f.state.failBootstrap = true;
  await assert.rejects(installOriginalIcon(f, f.deps), /bootstrap/);
  assert.equal(f.state.env, '');
  f.state.failBootstrap = false;
  const result = await installOriginalIcon(f, f.deps);
  assert.equal(f.state.env, result.shim);
});

test('non-macOS is rejected before filesystem or launchctl changes', async t => {
  if (!existsSync(url)) return;
  const { installOriginalIcon } = await import(url);
  const f = await fixture(t);
  await assert.rejects(installOriginalIcon(f, { ...f.deps, platform: 'linux' }), /macOS/);
  assert.equal(f.state.calls.length, 0);
});

test('foreign job under the same label is not adopted or stopped', async t => {
  const { installOriginalIcon, disableOriginalIcon } = await import(url);
  const f = await fixture(t);
  f.state.loaded = true;
  f.state.foreign = true;
  await assert.rejects(installOriginalIcon(f, f.deps), /foreign|registered/i);
  assert.equal(f.state.env, '');
  f.state.loaded = false;
  f.state.foreign = false;
  await installOriginalIcon(f, f.deps);
  f.state.foreign = true;
  await assert.rejects(disableOriginalIcon(f, f.deps), /foreign|registered/i);
  assert.equal(f.state.loaded, true);
  assert.equal(f.state.calls.filter(a => a[0] === 'bootout').length, 0);
});

test('installed standalone helper disables even after the entire proxy root was removed', async t => {
  const { installOriginalIcon } = await import(url);
  const f = await fixture(t);
  const result = await installOriginalIcon(f, f.deps);
  await rm(f.root, { recursive: true });
  assert.equal(execFileSync(result.shim, ['--version'], { encoding: 'utf8' }), 'real:--version\n');
  const { disableOriginalIcon } = await import(pathToFileURL(path.join(path.dirname(result.shim), 'original-icon.mjs')));
  await disableOriginalIcon(f, f.deps);
  assert.equal(f.state.loaded, false);
  assert.equal(f.state.env, '');
});
