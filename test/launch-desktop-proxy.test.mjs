import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const url = new URL('../scripts/launch-desktop-proxy.mjs', import.meta.url);
test('persistent launcher API exists', () => assert.ok(existsSync(url)));
test('explicit launch injects only this app launch; existing app is never killed', async t => {
  if (!existsSync(url)) return;
  const { launchDesktopProxy } = await import(url);
  const root = await mkdtemp(path.join(os.tmpdir(), 'sidebar-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, '.owner'), 'codex-sidebar-flow-desktop-v1');
  const manifest = { owner: 'codex-sidebar-flow-desktop-v1', appPath: '/Applications/Codex.app',
    release: 'a'.repeat(64), proxy: path.join(root, 'codex-proxy') };
  await writeFile(path.join(root, 'installation.json'), JSON.stringify(manifest));
  await writeFile(manifest.proxy, '#!/bin/sh\n');
  const app = '/Applications/Codex.app/Contents/MacOS/Codex';
  const proxy = path.join(root, 'releases', manifest.release, 'experimental/stdio-observer-proxy.mjs');
  let rows = [{ pid: 1, ppid: 0, args: app }], opened = false;
  const commands = [];
  const deps = { processes: () => rows, sleep: async () => {}, run: (bin, args) => {
    commands.push([bin, args]);
    if (bin.endsWith('plutil')) return 'Codex';
    if (bin.endsWith('open')) { opened = true; rows = [{ pid: 2, ppid: 0, args: app }, { pid: 3, ppid: 2, args: `node ${proxy} app-server` }]; }
    else assert.fail('Unexpected system command');
    return '';
  } };
  assert.equal((await launchDesktopProxy({ root }, deps)).phase, 'restart-required');
  assert.equal(opened, false);
  rows = [];
  await writeFile(path.join(root, '.launch-lock'), '2147483647');
  assert.equal((await launchDesktopProxy({ root }, deps)).phase, 'proxy-attached');
  assert.deepEqual(commands.at(-1), ['/usr/bin/open', ['--env', `CODEX_CLI_PATH=${manifest.proxy}`, '-a', manifest.appPath]]);
});
