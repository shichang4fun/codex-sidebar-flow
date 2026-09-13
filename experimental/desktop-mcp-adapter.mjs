// Translate the prototype's small RPC surface into official, thread-scoped MCP
// calls. Desktop owns logical section IDs and invalidation. Never forge _meta.
import { PINNED_SECTION_ID, validateForceStatusSections } from './desktop-proxy-config.mjs';

export function desktopMcpAdapter(rpc, threadId, { contextThreadId = threadId, forceStatusSections, activeFastPath = false } = {}) {
  if ([threadId, contextThreadId].some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) {
    throw Error('Explicit task identity required');
  }
  const transient = code => Object.assign(Error(code), { code });
  async function call(tool, args) {
    let result;
    try {
      result = await rpc.request('mcpServer/tool/call', {
        threadId: contextThreadId, server: 'codex_app', tool, arguments: args,
      });
    } catch (error) {
      // Lifecycle cancellation is not a transport failure and must not retry.
      if (error.code === 'DESKTOP_RECONCILIATION_SUPERSEDED') throw error;
      throw transient('DESKTOP_MCP_UNAVAILABLE');
    }
    if (!result || result.isError === true) throw transient('DESKTOP_MCP_UNAVAILABLE');
    const text = result.content?.filter(item => item.type === 'text');
    if (text?.length !== 1 || typeof text[0].text !== 'string') throw Error('Invalid Desktop MCP result');
    try { return JSON.parse(text[0].text); } catch { throw Error('Invalid Desktop MCP JSON'); }
  }
  if (forceStatusSections !== undefined) return forceStatusAdapter(rpc, threadId,
    validateForceStatusSections(forceStatusSections), call, activeFastPath);
  async function snapshot() {
    const data = await call('list_threads', { limit: 50 });
    // Unknown protection is unavailable data, not a permanent task-policy
    // rejection. Reuse the manager's bounded retry/start-evidence handling.
    if (!Array.isArray(data?.threads) || !Array.isArray(data.pinnedThreads) || !Array.isArray(data.sections)
        || data.unavailableHosts?.some(host => typeof host !== 'string' || host === 'local')
        || data.unavailableSources?.length) throw transient('DESKTOP_MCP_UNAVAILABLE');
    return data;
  }
  function identity(data, id = threadId) {
    const matches = [...data.threads, ...data.pinnedThreads].filter(t => t.id === id);
    const t = matches[0];
    if (!matches.length) throw transient('TASK_NOT_VISIBLE');
    if (matches.length !== 1 || t.kind !== 'codex' || t.hostId !== 'local'
        || (t.projectId !== null && (typeof t.projectId !== 'string' || !t.projectId))
        || t.parentThreadId != null || t.ephemeral || t.archived || t.isArchived) throw Error('Ineligible local task');
    if (data.pinnedThreads.some(row => row.id === id)) throw Error('Protected pinned task');
    if (t.projectId !== null) {
      const parents = data.sections.filter(s => s.itemKeys?.includes(`codex:project:${t.projectId}`));
      // Project association and sidebar placement are independent. Only children
      // of an ordinary Projects entry are eligible; never move the Project itself.
      if (parents.length !== 1 || parents[0].sectionId !== 'threads') throw Error('Protected or unknown Project');
    }
    const memberships = data.sections.flatMap(s => (s.itemKeys ?? []).filter(k =>
      typeof k === 'string' && k.startsWith('codex:thread:') && k.endsWith(`:${id}`),
    ).map(() => s));
    if (!memberships.length && t.projectId !== null) return { task: t, section: { sectionId: 'chats', name: 'Tasks' } };
    if (!memberships.length) throw transient('MEMBERSHIP_NOT_READY');
    if (memberships.length !== 1) throw Error('Ambiguous task membership');
    return { task: t, section: memberships[0] };
  }
  const adapter = {
    // Each observer operation owns its snapshot. Never reuse it across queued
    // events or retries, and always refresh both sides of the write boundary.
    async withReconciliation(operation) {
      let cached;
      async function transactionSnapshot(method) {
        if (method !== 'thread/section/move') return cached ??= await snapshot();
        const before = cached;
        cached = undefined;
        const fresh = await snapshot();
        if (before) {
          const previous = identity(before), current = identity(fresh);
          if (previous.section.sectionId !== current.section.sectionId
              || previous.task.projectId !== current.task.projectId) throw Error('Task changed before move');
        }
        return fresh;
      }
      try {
        return await operation({ request: (method, params) => adapter.request(method, params, transactionSnapshot) });
      } finally { cached = undefined; }
    },
    async candidates() {
      const data = await snapshot();
      return data.threads.slice(0, 50).flatMap(t => {
        try {
          const { section } = identity(data, t.id);
          return section.sectionId === 'chats' || ['In Progress', 'For Review', 'For Later'].includes(section.name) ? [t.id] : [];
        } catch { return []; }
      });
    },
    async request(method, params = {}, readSnapshot = snapshot) {
      if (!['threadSection/list', 'thread/read', 'thread/section/move'].includes(method)) throw Error('Unsupported adapter method');
      if (method !== 'threadSection/list' && params.threadId !== threadId) throw Error('Cross-task operation forbidden');
      const data = await readSnapshot(method);
      if (method === 'threadSection/list') return { data: data.sections.map(s => ({ id: s.sectionId, name: s.name })) };
      const { task, section } = identity(data);
      if (method === 'thread/read') {
        const result = await call('read_thread', { threadId, hostId: 'local', turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 1 });
        const t = result?.thread;
        if (t?.id !== threadId || t.hostId !== 'local' || t.kind !== 'codex'
            || (Object.hasOwn(t, 'projectId') && t.projectId !== task.projectId)) throw Error('Desktop read identity mismatch');
        return { thread: { ...t, projectId: task.projectId,
          section: section.sectionId === 'chats' ? null : { id: section.sectionId, name: section.name },
        } };
      }
      const destination = data.sections.filter(s => s.sectionId === params.sectionId);
      const later = data.sections.filter(s => s.name === 'For Later');
      const startingDeferredTask = later.length === 1 && later[0].sectionId === section.sectionId
        && !['pinned', 'chats', 'threads'].includes(section.sectionId)
        && destination[0]?.name === 'In Progress';
      if (destination.length !== 1 || !['In Progress', 'For Review'].includes(destination[0].name)
          || ['pinned', 'chats', 'threads'].includes(destination[0].sectionId)
          || !(section.sectionId === 'chats' || ['In Progress', 'For Review'].includes(section.name) || startingDeferredTask)) {
        throw Error('Protected section');
      }
      // Keep an authoritative read adjacent to the write. A section snapshot
      // alone does not prove the task is still running or waiting for review.
      const latest = (await call('read_thread', { threadId, hostId: 'local', turnLimit: 1,
        includeOutputs: false, maxOutputCharsPerItem: 1 }))?.thread;
      const status = latest?.status;
      const active = status?.type === 'active' && Array.isArray(status.activeFlags)
        && status.activeFlags.every(f => ['waitingOnApproval', 'waitingOnUserInput'].includes(f));
      const matchesTarget = destination[0].name === 'In Progress'
        ? active && status.activeFlags.length === 0
        : (active && status.activeFlags.length > 0) || ['idle', 'systemError'].includes(status?.type);
      if (latest?.id !== threadId || latest.hostId !== 'local' || latest.kind !== 'codex'
          || latest.archived || latest.isArchived || latest.parentThreadId != null
          || (Object.hasOwn(latest, 'projectId') && latest.projectId !== task.projectId)
          || latest.ephemeral || !matchesTarget) throw Error('Task changed before move');
      const result = await call('move_thread_to_sidebar_section', { threadId, hostId: 'local', sectionId: params.sectionId });
      if (result?.threadId !== threadId || result.hostId !== 'local' || result.sectionId !== params.sectionId) {
        throw Error('Desktop move response mismatch');
      }
      return {};
    },
  };
  return adapter;
}

// Explicit opt-in: only direct Pinned placement is protected. Read only the
// attached local server; use the native Desktop move solely for UI invalidation.
// Configured logical/raw IDs are deployment inputs, not inferred from task data.
function forceStatusAdapter(rpc, threadId, mapping, call, activeFastPath) {
  // Reserved App Server section in the tested Desktop build, not a user ID.
  const pinnedId = PINNED_SECTION_ID;
  const names = { inProgress: 'In Progress', forReview: 'For Review' };
  const roots = ['cli', 'vscode', 'exec', 'appServer', 'unknown'];
  let previous;
  async function local(method, params = {}) {
    try { return await rpc.request(method, params); }
    catch (error) {
      if (error.code === 'DESKTOP_RECONCILIATION_SUPERSEDED') throw error;
      throw Object.assign(Error('DESKTOP_MCP_UNAVAILABLE'), { code: 'DESKTOP_MCP_UNAVAILABLE' });
    }
  }
  async function read() {
    const t = (await local('thread/read', { threadId, includeTurns: false }))?.thread;
    if (t?.id !== threadId || t.parentThreadId != null || t.ephemeral !== false
        || !roots.includes(t.source) || typeof t.cwd !== 'string' || !t.cwd
        || (t.hostId !== undefined && t.hostId !== 'local') || t.archived || t.isArchived) throw Error('Ineligible local task');
    if (t.section?.id === pinnedId) throw Error('Protected Pinned task');
    if (t.section !== null && (typeof t.section?.id !== 'string' || !t.section.id)) throw Error('Unknown local placement');
    return t;
  }
  async function nonarchived(t) {
    // Only live force-status starts opt in. On the tested bundled server,
    // archive unloads the task and another process cannot archive an active
    // writer. A fresh active read need not wait for list preview materialization.
    // read() still checks Pinned/identity; the final read below must still be active.
    if (activeFastPath === true && t.status?.type === 'active'
        && Array.isArray(t.status.activeFlags) && t.status.activeFlags.length === 0) return;
    // Raw thread/read omits archive status. Query only this local cwd/source;
    // follow pages so old tasks are not confused with archived/absent tasks.
    let cursor = null;
    const seen = new Set();
    do {
      const page = await local('thread/list', { archived: false, useStateDbOnly: true,
        cwd: t.cwd, sourceKinds: [t.source], sortKey: 'updated_at', limit: 1000, cursor });
      if (!Array.isArray(page?.data)) throw Error('Invalid local task page');
      if (page.data.some(row => row.id === threadId)) return;
      cursor = page.nextCursor ?? null;
      if (cursor !== null && (typeof cursor !== 'string' || !cursor || seen.has(cursor))) throw Error('Invalid local task cursor');
      seen.add(cursor);
    } while (cursor !== null);
    // A new task may emit start before its first user input makes it list-visible.
    // Absence still forbids writes, but lets lifecycle handling reuse its bounded
    // retry budget. Archived/never-visible tasks exhaust that budget without moving.
    throw Object.assign(Error('Local task not in nonarchived pages'), { code: 'TASK_NOT_VISIBLE' });
  }
  async function destinations() {
    const data = [], seen = new Set();
    let cursor = null;
    do {
      const page = await local('threadSection/list', { limit: 100, cursor });
      if (!Array.isArray(page?.data)) throw Error('Missing local sections');
      data.push(...page.data);
      cursor = page.nextCursor ?? null;
      if (cursor !== null && (typeof cursor !== 'string' || !cursor || seen.has(cursor))) throw Error('Invalid local section cursor');
      seen.add(cursor);
    } while (cursor !== null);
    if (data.filter(s => s.id === pinnedId).length !== 1) throw Error('Missing local pinned projection');
    return Object.entries(mapping).map(([key, pair]) => {
      const matches = data.filter(s => s.id === pair.localId || s.name === names[key]);
      if (matches.length !== 1 || matches[0].id !== pair.localId || matches[0].name !== names[key]) throw Error('Configured section changed');
      return { id: pair.desktopId, name: names[key] };
    });
  }
  return { async request(method, params = {}) {
    if (!['threadSection/list', 'thread/read', 'thread/section/move'].includes(method)
        || (method !== 'threadSection/list' && params.threadId !== threadId)) throw Error('Unsupported force-status operation');
    if (method === 'threadSection/list') return { data: await destinations() };
    if (method === 'thread/read') {
      const t = await read(); await nonarchived(t); previous = t;
      const pair = Object.values(mapping).find(s => s.localId === t.section?.id);
      return { thread: { ...t, section: pair ? { ...t.section, id: pair.desktopId } : t.section ?? null } };
    }
    const entry = Object.entries(mapping).find(([, s]) => s.desktopId === params.sectionId);
    if (!entry || !previous) throw Error('Unknown move destination');
    await destinations(); await nonarchived(previous);
    const latest = await read(); // Fresh exact-task status immediately before the native write.
    const s = latest.status;
    const active = s?.type === 'active' && Array.isArray(s.activeFlags)
      && s.activeFlags.every(f => ['waitingOnApproval', 'waitingOnUserInput'].includes(f));
    const desired = active ? (s.activeFlags.length ? 'forReview' : 'inProgress')
      : ['idle', 'systemError'].includes(s?.type) ? 'forReview' : null;
    if (entry[0] !== desired) throw Error('Task changed before move');
    const result = await call('move_thread_to_sidebar_section', { threadId, hostId: 'local', sectionId: params.sectionId });
    if (result?.threadId !== threadId || result.hostId !== 'local' || result.sectionId !== params.sectionId) throw Error('Desktop move response mismatch');
    const after = await read();
    if (after.section?.id !== entry[1].localId || after.projectId !== latest.projectId) throw Error('Local move readback mismatch');
    return {};
  } };
}
