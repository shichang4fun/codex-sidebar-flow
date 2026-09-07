// Translate the prototype's small RPC surface into official, thread-scoped MCP
// calls. Desktop owns logical section IDs and invalidation. Never forge _meta.
export function desktopMcpAdapter(rpc, threadId, { contextThreadId = threadId } = {}) {
  if ([threadId, contextThreadId].some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) {
    throw Error('Explicit task identity required');
  }
  async function call(tool, args) {
    const result = await rpc.request('mcpServer/tool/call', {
      threadId: contextThreadId, server: 'codex_app', tool, arguments: args,
    });
    if (!result || result.isError === true) throw Error('Desktop MCP tool failed');
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
    if (matches.length !== 1 || t.kind !== 'codex' || t.hostId !== 'local'
        || t.projectId !== null || t.archived || t.isArchived) throw Error('Ineligible local task');
    const memberships = data.sections.flatMap(s => (s.itemKeys ?? []).filter(k =>
      typeof k === 'string' && k.startsWith('codex:thread:') && k.endsWith(`:${id}`),
    ).map(() => s));
    if (memberships.length !== 1) throw Error('Ambiguous or missing task membership');
    return { task: t, section: memberships[0] };
  }
  return {
    async candidates() {
      const data = await snapshot();
      return data.threads.slice(0, 50).flatMap(t => {
        try {
          const { section } = identity(data, t.id);
          return section.sectionId === 'chats' || ['In Progress', 'For Review'].includes(section.name) ? [t.id] : [];
        } catch { return []; }
      });
    },
    async request(method, params = {}) {
      if (!['threadSection/list', 'thread/read', 'thread/section/move'].includes(method)) throw Error('Unsupported adapter method');
      if (method !== 'threadSection/list' && params.threadId !== threadId) throw Error('Cross-task operation forbidden');
      const data = await snapshot();
      if (method === 'threadSection/list') return { data: data.sections.map(s => ({ id: s.sectionId, name: s.name })) };
      const { task, section } = identity(data);
      if (method === 'thread/read') {
        const result = await call('read_thread', { threadId, hostId: 'local', turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 1 });
        const t = result?.thread;
        if (t?.id !== threadId || t.hostId !== 'local' || t.kind !== 'codex'
            || t.projectId != null) throw Error('Desktop read identity mismatch');
        return { thread: { ...t, projectId: task.projectId,
          section: section.sectionId === 'chats' ? null : { id: section.sectionId, name: section.name },
        } };
      }
      const destination = data.sections.filter(s => s.sectionId === params.sectionId);
      if (destination.length !== 1 || !['In Progress', 'For Review'].includes(destination[0].name)
          || ['pinned', 'chats', 'threads'].includes(destination[0].sectionId)
          || !(section.sectionId === 'chats' || ['In Progress', 'For Review'].includes(section.name))) {
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
          || latest.archived || latest.isArchived || latest.parentThreadId != null || latest.projectId != null
          || latest.ephemeral || !matchesTarget) throw Error('Task changed before move');
      const result = await call('move_thread_to_sidebar_section', { threadId, hostId: 'local', sectionId: params.sectionId });
      if (result?.threadId !== threadId || result.hostId !== 'local' || result.sectionId !== params.sectionId) {
        throw Error('Desktop move response mismatch');
      }
      return {};
    },
  };
}
