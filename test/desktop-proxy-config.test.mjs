import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const url = new URL('../experimental/desktop-proxy-config.mjs', import.meta.url);
test('persistent desktop proxy configuration API exists', () => {
  assert.ok(existsSync(url), 'desktop proxy configuration module is missing');
});

test('all-local is explicit; unknown modes and malformed identities fail closed', async () => {
  if (!existsSync(url)) return;
  const { validateProxyConfig, isManagedTask } = await import(url);
  const config = validateProxyConfig({ version: 1, mode: 'all-local', excludedThreadIds: ['organizer'] });
  assert.equal(isManagedTask(config, 'ordinary-task'), true);
  assert.equal(isManagedTask(config, 'organizer'), false);
  assert.equal(isManagedTask(config, undefined), false);
  for (const bad of [{}, { version: 1, mode: 'all' }, { version: 1, mode: 'all-local', excludedThreadIds: 'oops' },
    { version: 1, mode: 'allowlist', threadIds: [] }]) assert.throws(() => validateProxyConfig(bad));
  const scoped = validateProxyConfig({ version: 1, mode: 'allowlist', threadIds: ['a', 'b'], excludedThreadIds: ['b'] });
  assert.equal(isManagedTask(scoped, 'a'), true);
  assert.equal(isManagedTask(scoped, 'b'), false);
  assert.equal(isManagedTask(scoped, 'new-task'), false);
});
