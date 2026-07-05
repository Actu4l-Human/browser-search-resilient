import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { health, webFetch, webResearch, webSearch } from './orchestrator.js';

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'resilient-browser-search', version: '0.1.0' });

  server.registerTool('web_search', {
    description: 'Search the public web through SearXNG. If the search service is unavailable or blocked, retry through the deterministic browser fallback chain.',
    inputSchema: z.object({
      query: z.string().min(1).max(2000),
      maxResults: z.number().int().min(1).max(50).default(10),
      language: z.string().min(2).max(32).default('en'),
      categories: z.array(z.string()).max(10).optional(),
      timeRange: z.enum(['day', 'week', 'month', 'year']).optional(),
      includeDomains: z.array(z.string()).max(50).optional(),
      excludeDomains: z.array(z.string()).max(50).optional(),
    }),
  }, async (input: any) => result(await webSearch(input.query, input)));

  server.registerTool('web_fetch', {
    description: 'Retrieve a public URL. Auto mode uses direct HTTP first, Camofox for JavaScript or challenge pages, and CloakBrowser as the final fallback. Authentication, paywalls, policy denials, and unresolved human verification are not bypassed.',
    inputSchema: z.object({
      url: z.string().url(),
      backend: z.enum(['auto', 'direct', 'camofox', 'cloakbrowser']).default('auto'),
      maxCharacters: z.number().int().min(1000).max(200000).default(50000),
      includeLinks: z.boolean().default(true),
    }),
  }, async (input: any) => result(await webFetch(input.url, input)));

  server.registerTool('web_research', {
    description: 'Search, retrieve, and return multiple public sources with complete backend attempt history for source-grounded agent research.',
    inputSchema: z.object({
      query: z.string().min(1).max(2000),
      maxSources: z.number().int().min(1).max(20).default(6),
      maxCharactersPerSource: z.number().int().min(1000).max(100000).default(30000),
      language: z.string().min(2).max(32).default('en'),
      categories: z.array(z.string()).max(10).optional(),
      timeRange: z.enum(['day', 'week', 'month', 'year']).optional(),
      includeDomains: z.array(z.string()).max(50).optional(),
      excludeDomains: z.array(z.string()).max(50).optional(),
    }),
  }, async (input: any) => result(await webResearch(input.query, input)));

  server.registerTool('web_health', {
    description: 'Check the orchestrator and its SearXNG, Camofox, and CloakBrowser backends. Deep mode launches CloakBrowser against example.com.',
    inputSchema: z.object({ deep: z.boolean().default(false) }),
  }, async ({ deep }: { deep: boolean }) => result(await health(deep)));

  return server;
}
