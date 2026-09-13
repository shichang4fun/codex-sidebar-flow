// Translate the prototype's small RPC surface into official, thread-scoped MCP
// calls. Desktop owns logical section IDs and invalidation. Never forge _meta.
export function desktopMcpAdapter(rpc, threadId, { contextThreadId = threadId } = {}) {
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
  async function snapshot() {
    const data = await call('list_threads', { limit: 50 });
    if (!Array.isArray(data?.threads) || !Array.isArray(data.pinnedThreads) || !Array.isArray(data.sections)
        || data.unavailableHosts?.some(host => typeof host !== 'string' || host === 'local')
        || data.unavailableSources?.length) throw Error('Incomplete Desktop snapshot');
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
