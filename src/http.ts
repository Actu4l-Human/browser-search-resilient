import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { createServer } from './mcp.js';
import { health, webFetch, webResearch, webSearch, inFlight, log } from './orchestrator.js';
import { fetchInputSchema, researchInputSchema, searchInputSchema, toFetchOptions, toResearchOptions, toSearchOptions } from './schemas.js';
import { checkBearer } from './security/auth.js';
import { metrics } from './util/metrics.js';
import { RateLimiter } from './util/rate-limiter.js';
import { closeCloakBrowser } from './backends/cloakbrowser.js';

const app: FastifyInstance = createMcpFastifyApp({
  host: config.host,
  allowedHosts: config.allowedHosts,
  ...(config.allowedOrigins.length ? { allowedOrigins: config.allowedOrigins } : {}),
});

const rateLimiter = new RateLimiter(config.rateLimitRpm, config.rateLimitBurst);

function clientKey(request: FastifyRequest): string {
  return request.ip ?? 'unknown';
}

app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
  if (request.url === '/healthz' || request.url === '/readyz' || request.url === '/metrics') return;
  if (!checkBearer(request.headers.authorization, config.apiKey)) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  if (rateLimiter.enabled && !rateLimiter.consume(clientKey(request))) {
    return reply.code(429).send({ error: 'Rate limit exceeded' });
  }
});

app.addHook('onRequest', async (request: FastifyRequest) => {
  metrics.recordRequest();
  (request as any).startedAt = process.hrtime.bigint();
});

app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
  metrics.recordResponse(reply.statusCode);
  const startedAt = (request as any).startedAt as bigint | undefined;
  if (startedAt) metrics.observeDuration(Number(process.hrtime.bigint() - startedAt) / 1e6);
});

app.get('/healthz', async () => ({ status: 'ok' }));
app.get('/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
  reply.type('text/plain; version=0.0.4').send(metrics.toOpenMetrics());
});
app.get('/readyz', async (_request: FastifyRequest, reply: FastifyReply) => {
  const state = await health(false);
  const ready = state.searxng === 'ok' && state.camofox === 'ok';
  return reply.code(ready ? 200 : 503).send(state);
});

function validate<T>(
  schema: { safeParse: (input: unknown) => { success: boolean; data?: T; error?: { issues?: { message: string }[] } } },
  body: unknown,
  reply: FastifyReply,
): T | undefined {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    reply.code(400).send({ error: 'Invalid request', details: parsed.error?.issues?.map((issue) => issue.message) ?? [] });
    return undefined;
  }
  return parsed.data;
}

app.post('/v1/search', async (request: FastifyRequest, reply: FastifyReply) => {
  const input = validate(searchInputSchema, request.body, reply);
  if (!input) return;
  metrics.recordTool('web_search');
  return webSearch(input.query, toSearchOptions(input));
});
app.post('/v1/fetch', async (request: FastifyRequest, reply: FastifyReply) => {
  const input = validate(fetchInputSchema, request.body, reply);
  if (!input) return;
  metrics.recordTool('web_fetch');
  return webFetch(input.url, toFetchOptions(input));
});
app.post('/v1/research', async (request: FastifyRequest, reply: FastifyReply) => {
  const input = validate(researchInputSchema, request.body, reply);
  if (!input) return;
  metrics.recordTool('web_research');
  return webResearch(input.query, toResearchOptions(input));
});

const mcpHandler = createMcpHandler(() => createServer(), { responseMode: 'json' });
const nodeHandler = toNodeHandler(mcpHandler);
app.all('/mcp', (request: FastifyRequest, reply: FastifyReply) => nodeHandler(request.raw as never, reply.raw as never, request.body));

await app.listen({ host: config.host, port: config.port });
log.info('HTTP server listening', { host: config.host, port: config.port, auth: Boolean(config.apiKey), rateLimit: rateLimiter.enabled });

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Shutting down', { signal, inFlight: inFlight.size });
  await Promise.race([inFlight.drain(10_000), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  await closeCloakBrowser();
  await mcpHandler.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
