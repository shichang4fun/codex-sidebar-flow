import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, symlinkSync, linkSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('timing sink keeps private bounded JSONL and resets an oversized owned log', async t => {
  const { createTimingWriter } = await import('../experimental/desktop-timing.mjs');
  const root = mkdtempSync(join(tmpdir(), 'sidebar-timing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = createTimingWriter(root), file = join(root, 'timings.jsonl');
  assert.equal(write({ queueMs: 10 }), true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).queueMs, 10);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(file, 'x'.repeat(256 * 1024));
  assert.equal(write({ queueMs: 20 }), true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).queueMs, 20);
  const before = readFileSync(file, 'utf8');
  assert.equal(write({ oversized: 'x'.repeat(4096) }), false);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('timing sink refuses symlink, hardlink, public file and unsafe parent without changing targets', async t => {
  const { createTimingWriter } = await import('../experimental/desktop-timing.mjs');
  const root = mkdtempSync(join(tmpdir(), 'sidebar-timing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'timings.jsonl'), target = join(root, 'target');
  writeFileSync(target, 'preserve', { mode: 0o600 });
  const write = createTimingWriter(root);
  symlinkSync(target, file);
  assert.equal(write({ queueMs: 1 }), false);
  assert.equal(readFileSync(target, 'utf8'), 'preserve');
  rmSync(file); linkSync(target, file);
  assert.equal(write({ queueMs: 1 }), false);
  assert.equal(readFileSync(target, 'utf8'), 'preserve');
  rmSync(file); writeFileSync(file, 'preserve', { mode: 0o644 });
  assert.equal(write({ queueMs: 1 }), false);
  assert.equal(readFileSync(file, 'utf8'), 'preserve');
  chmodSync(file, 0o600); chmodSync(root, 0o755);
  assert.equal(write({ queueMs: 1 }), false);
  assert.equal(readFileSync(file, 'utf8'), 'preserve');
});
