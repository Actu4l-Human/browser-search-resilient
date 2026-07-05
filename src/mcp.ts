import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { health, webFetch, webResearch, webSearch } from './orchestrator.js';
import { fetchInputSchema, researchInputSchema, searchInputSchema } from './schemas.js';

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'resilient-browser-search', version: '0.1.0' });

  server.registerTool(
    'web_search',
    {
      description:
        'Search the public web through SearXNG. If the search service is unavailable or blocked, retry through the deterministic browser fallback chain.',
      inputSchema: searchInputSchema,
    },
    async (input: any) => result(await webSearch(input.query, input)),
  );

  server.registerTool(
    'web_fetch',
    {
      description:
        'Retrieve a public URL. Auto mode uses direct HTTP first, Camofox for JavaScript or challenge pages, and CloakBrowser as the final fallback. Authentication, paywalls, policy denials, and unresolved human verification are not bypassed.',
      inputSchema: fetchInputSchema,
    },
    async (input: any) => result(await webFetch(input.url, input)),
  );

  server.registerTool(
    'web_research',
    {
      description:
        'Search, retrieve, and return multiple public sources with complete backend attempt history for source-grounded agent research.',
      inputSchema: researchInputSchema,
    },
    async (input: any) => result(await webResearch(input.query, input)),
  );

  server.registerTool(
    'web_health',
    {
      description:
        'Check the orchestrator and its SearXNG, Camofox, egress proxy, and CloakBrowser backends. Deep mode launches CloakBrowser against example.com.',
      inputSchema: z.object({ deep: z.boolean().default(false) }),
    },
    async ({ deep }: { deep: boolean }) => result(await health(deep)),
  );

  return server;
}
