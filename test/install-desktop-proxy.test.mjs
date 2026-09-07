import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const url = new URL('../scripts/install-desktop-proxy.mjs', import.meta.url);
test('standalone desktop proxy installer exists', () => assert.ok(existsSync(url)));
test('install creates a persistent explicit launcher, preserves config, uninstall is recoverable', async t => {
  if (!existsSync(url)) return;
  const { installDesktopProxy, uninstallDesktopProxy } = await import(url);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sidebar-install-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "my ' install");
  const options = { root, nodePath: process.execPath, appPath: '/Applications/ChatGPT.app',
    realCodex: process.execPath, config: { version: 1, mode: 'all-local', excludedThreadIds: ['organizer'] } };
  const result = await installDesktopProxy(options);
  assert.ok(existsSync(result.launcher));
  assert.ok(existsSync(path.join(root, 'Uninstall Codex Sidebar Flow.command')),
    'Uninstall must not require keeping the source checkout');
  const launch = await readFile(result.launcher, 'utf8');
  assert.match(launch, /launch-desktop-proxy\.mjs/);
  assert.ok(existsSync(path.join(root, 'Codex Sidebar Flow.app/Contents/Info.plist')));
  assert.match(await readFile(path.join(root, 'codex-proxy'), 'utf8'), /SIDEBAR_FLOW_CONFIG_FILE/);
  const user = { version: 1, mode: 'allowlist', threadIds: ['kept'], excludedThreadIds: ['organizer'] };
  await writeFile(path.join(root, 'config.json'), JSON.stringify(user));
  await installDesktopProxy(options);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')), user);
  const uninstalled = JSON.parse(execFileSync('/bin/sh', [path.join(root, 'Uninstall Codex Sidebar Flow.command')], { encoding: 'utf8' }));
  assert.equal(existsSync(root), false);
  assert.ok(existsSync(uninstalled.backup));
  assert.ok(existsSync(path.join(uninstalled.backup, 'config.json')));
  assert.deepEqual(JSON.parse(await readFile(path.join(uninstalled.backup, 'config.json'), 'utf8')), user,
    'Recoverable uninstall must preserve the original configuration exactly');
});

test('uninstall refuses to race an active launch waiter', async t => {
  const { installDesktopProxy, uninstallDesktopProxy } = await import(url);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sidebar-lock-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'install');
  await installDesktopProxy({ root, nodePath: process.execPath, appPath: '/Applications/Codex.app',
    realCodex: process.execPath, config: { version: 1, mode: 'all-local', excludedThreadIds: ['organizer'] } });
  await writeFile(path.join(root, '.launch-lock'), String(process.pid));
  await assert.rejects(uninstallDesktopProxy({ root }));
  assert.equal(JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')).mode, 'all-local');
});
test('installer refuses unowned directories and symlink roots', async t => {
  if (!existsSync(url)) return;
  const { installDesktopProxy, uninstallDesktopProxy } = await import(url);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sidebar-unowned-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'existing'); await mkdir(root);
  await writeFile(path.join(root, 'personal.txt'), 'keep');
  await assert.rejects(installDesktopProxy({ root }));
  await assert.rejects(uninstallDesktopProxy({ root }));
  assert.equal(await readFile(path.join(root, 'personal.txt'), 'utf8'), 'keep');
  const linked = path.join(temp, 'linked'); await symlink(root, linked);
  await assert.rejects(installDesktopProxy({ root: linked }));
});
