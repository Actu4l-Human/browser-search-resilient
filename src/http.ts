import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { config } from './config.js';
import { createServer } from './mcp.js';
import { health, webFetch, webResearch, webSearch } from './orchestrator.js';

const app = createMcpFastifyApp({
  host: config.host,
  allowedHosts: config.allowedHosts,
  ...(config.allowedOrigins.length ? { allowedOrigins: config.allowedOrigins } : {}),
  logger: true,
});

function authorized(header: string | string[] | undefined): boolean {
  if (!config.apiKey) return true;
  const value = Array.isArray(header) ? header[0] : header;
  return value === `Bearer ${config.apiKey}`;
}

app.get('/healthz', async () => ({ status: 'ok' }));
app.get('/readyz', async (_request: any, reply: any) => {
  const state = await health(false);
  const ready = state.searxng === 'ok' && state.camofox === 'ok';
  return reply.code(ready ? 200 : 503).send(state);
});

app.addHook('preHandler', async (request: any, reply: any) => {
  if (request.url === '/healthz' || request.url === '/readyz') return;
  if (!authorized(request.headers.authorization)) return reply.code(401).send({ error: 'Unauthorized' });
});

app.post('/v1/search', async (request: any) => {
  const body = request.body as { query: string } & Record<string, unknown>;
  return webSearch(body.query, body as any);
});
app.post('/v1/fetch', async (request: any) => {
  const body = request.body as { url: string } & Record<string, unknown>;
  return webFetch(body.url, body as any);
});
app.post('/v1/research', async (request: any) => {
  const body = request.body as { query: string } & Record<string, unknown>;
  return webResearch(body.query, body as any);
});

const mcpHandler = createMcpHandler(() => createServer(), { responseMode: 'json' });
const nodeHandler = toNodeHandler(mcpHandler);
app.all('/mcp', (request: any, reply: any) => nodeHandler(request.raw, reply.raw, request.body));

await app.listen({ host: config.host, port: config.port });

const shutdown = async () => {
  await mcpHandler.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
