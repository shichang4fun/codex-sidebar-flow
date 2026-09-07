const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
function ids(value = []) {
  if (!Array.isArray(value) || value.length > 1000 || value.some(id => !validId(id))
      || new Set(value).size !== value.length) throw Error('Invalid task identities');
  return [...value];
}

export function validateProxyConfig(value) {
  if (!value || value.version !== 1 || !['allowlist', 'all-local', 'disabled'].includes(value.mode)) {
    throw Error('Explicit desktop proxy mode required');
  }
  const threadIds = ids(value.threadIds), excludedThreadIds = ids(value.excludedThreadIds);
  const reconcileIntervalSeconds = value.reconcileIntervalSeconds === undefined ? 60 : value.reconcileIntervalSeconds;
  if (!Number.isInteger(reconcileIntervalSeconds) || (reconcileIntervalSeconds !== 0
      && (reconcileIntervalSeconds < 15 || reconcileIntervalSeconds > 3600))) throw Error('Invalid reconciliation interval');
  if (value.mode === 'allowlist' && threadIds.length === 0) throw Error('Empty allowlist');
  return { version: 1, mode: value.mode, threadIds, excludedThreadIds, reconcileIntervalSeconds };
}

export function isManagedTask(config, id) {
  return validId(id) && config.mode !== 'disabled' && !config.excludedThreadIds.includes(id)
    && (config.mode === 'all-local' || config.threadIds.includes(id));
}
