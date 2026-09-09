// Local, no-key demonstration. Run with NODE_OPTIONS=--conditions=development.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMemoryReplaySavings } from '@agent-rewind/core';
import { createMemoryRecordStore, createReplayer, startProxy } from '@agent-rewind/gateway';
import { createRewindMcpServer } from '../packages/mcp/src/server.ts';

const workspace = await mkdtemp(join(tmpdir(), 'rewind-v11-demo-'));
let calls = 0, proxy, mcp, client;
const answer = JSON.stringify({ object: 'response', id: 'resp_demo', status: 'completed', model: 'demo-model',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Rewind is working.' }] }],
  usage: { input_tokens: 150, output_tokens: 20, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 30 } } });
const upstream = createServer(async (req, res) => {
  for await (const chunk of req) { /* Consume request without logging its content. */ }
  calls++;
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(answer);
});
try {
  console.log('REWIND v1.1 DEVELOPMENT DEMO — local fixture, no API key or paid calls');
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const store = createMemoryRecordStore();
  proxy = await startProxy({ upstreamBase: `http://127.0.0.1:${upstream.address().port}`,
    store, replayer: createReplayer(store, createMemoryReplaySavings()) });
  const modes = [], bodies = [];
  for (let i = 0; i < 2; i++) {
    const result = await fetch(`${proxy.url}/v1/responses`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'demo-model', input: 'Demonstrate exact replay.' }) });
    modes.push(result.headers.get('x-rewind')); bodies.push(await result.text());
  }
  assert.deepEqual(modes, ['live', 'replay']); assert.equal(calls, 1); assert.equal(bodies[0], bodies[1]);
  console.log('Responses request 1: LIVE');
  console.log('Responses request 2: REPLAY');
  console.log(`Upstream calls: ${calls} for 2 requests; response bytes identical: ${bodies[0] === bodies[1]}`);
  console.log('Replay storage in this demo: memory (durable gateway integration remains in progress).');
  await writeFile(join(workspace, 'example.txt'), 'A real file in a disposable workspace.\n');
  mcp = createRewindMcpServer({ cwd: workspace, profile: 'lean', log: () => {} });
  client = new Client({ name: 'rewind-demo', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(b), client.connect(a)]);
  const { tools } = await client.listTools();
  const chars = JSON.stringify(tools).length + client.getInstructions().length;
  console.log(`Lean MCP tools: ${tools.map((tool) => tool.name).join(', ')}`);
  console.log(`Initialization: ${chars} characters; ${Math.ceil(chars / 4)} approximate tokens (not billed usage)`);
  const checkpoint = await client.callTool({ name: 'checkpoint', arguments: { label: 'demo' } });
  assert.ok(checkpoint.structuredContent?.id); assert.ok(!checkpoint.isError);
  console.log('Checkpoint: CREATED through the real MCP SDK over a disposable workspace');
  console.log('PASS — this demonstrates implemented pieces, not a completed v1.1 release.');
} finally {
  await client?.close(); await mcp?.close(); await proxy?.close();
  upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
  await rm(workspace, { recursive: true, force: true });
}
