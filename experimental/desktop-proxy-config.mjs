const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
export const PINNED_SECTION_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf318';
export function validateForceStatusSections(value) {
  const uuid = id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
  const pairs = ['inProgress', 'forReview'].map(key => {
    const pair = value?.[key];
    if (!uuid(pair?.desktopId) || !uuid(pair?.localId)
        || [pair.desktopId, pair.localId].some(id => id.toLowerCase() === PINNED_SECTION_ID)) throw Error('Explicit non-Pinned Desktop/local section UUID pairs required');
    return [key, { desktopId: pair.desktopId, localId: pair.localId }];
  });
  for (const field of ['desktopId', 'localId']) {
    if (pairs[0][1][field].toLowerCase() === pairs[1][1][field].toLowerCase()) throw Error('Distinct destinations required');
  }
  return Object.fromEntries(pairs);
}
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
  return { version: 1, mode: value.mode, threadIds, excludedThreadIds, reconcileIntervalSeconds,
    ...(value.forceStatusSections !== undefined ? { forceStatusSections: validateForceStatusSections(value.forceStatusSections) } : {}) };
}

export function isManagedTask(config, id) {
  return validId(id) && config.mode !== 'disabled' && !config.excludedThreadIds.includes(id)
    && (config.mode === 'all-local' || config.threadIds.includes(id));
}
