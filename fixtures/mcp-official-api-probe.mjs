// Isolated integration fixture only. No filesystem, app or network access.
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id == null) continue;
  let result;
  switch (message.method) {
    case 'initialize':
      result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'sidebar-test-fixture', version: '1.0.0' } };
      break;
    case 'tools/list':
      result = { tools: [{ name: 'probe', description: 'Local fixture', inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] } }] };
      break;
    case 'tools/call':
      result = message.params.name === 'probe'
        ? { content: [{ type: 'text', text: JSON.stringify({ marker: message.params.arguments.marker, meta: message.params._meta ?? null }) }] }
        : { content: [], isError: true };
      break;
    default: result = {};
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
}
