import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { health, webFetch, webResearch, webSearch } from './orchestrator.js';
import { fetchInputSchema, researchInputSchema, searchInputSchema, toFetchOptions, toResearchOptions, toSearchOptions } from './schemas.js';
import { metrics } from './util/metrics.js';

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'resilient-browser-search', version: '0.2.1' });

  server.registerTool(
    'web_search',
    {
      description:
        'Search the public web through SearXNG. If the search service is unavailable or blocked, retry through the deterministic browser fallback chain.',
      inputSchema: searchInputSchema,
    },
    async (input: z.infer<typeof searchInputSchema>) => {
      metrics.recordTool('web_search');
      return result(await webSearch(input.query, toSearchOptions(input)));
    },
  );

  server.registerTool(
    'web_fetch',
    {
      description:
        'Retrieve a public URL. Auto mode uses direct HTTP first, optional Crawl4AI Markdown extraction when configured, Camofox for JavaScript or challenge pages, and CloakBrowser as the final fallback. Obscura is an experimental, explicitly selected backend and is not part of the auto chain. Authentication, paywalls, policy denials, and unresolved human verification are not bypassed.',
      inputSchema: fetchInputSchema,
    },
    async (input: z.infer<typeof fetchInputSchema>) => {
      metrics.recordTool('web_fetch');
      return result(await webFetch(input.url, toFetchOptions(input)));
    },
  );

  server.registerTool(
    'web_research',
    {
      description:
        'Search, retrieve, and return multiple public sources with complete backend attempt history for source-grounded agent research.',
      inputSchema: researchInputSchema,
    },
    async (input: z.infer<typeof researchInputSchema>) => {
      metrics.recordTool('web_research');
      return result(await webResearch(input.query, toResearchOptions(input)));
    },
  );

  server.registerTool(
    'web_health',
    {
      description:
        'Check the orchestrator, selected stack profile, SearXNG, Crawl4AI, Camofox, egress proxy, CloakBrowser, Obscura, and Scrapling backends. Deep mode launches enabled browser extraction backends against example.com.',
      inputSchema: z.object({ deep: z.boolean().default(false) }),
    },
    async ({ deep }: { deep: boolean }) => {
      metrics.recordTool('web_health');
      return result(await health(deep));
    },
  );

  return server;
}
