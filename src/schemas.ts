import * as z from 'zod/v4';
import type { FetchOptions, SearchOptions } from './types.js';

export const searchInputSchema = z.object({
  query: z.string().min(1).max(2000),
  maxResults: z.number().int().min(1).max(50).default(10),
  language: z.string().min(2).max(32).default('en'),
  categories: z.array(z.string()).max(10).optional(),
  timeRange: z.enum(['day', 'week', 'month', 'year']).optional(),
  includeDomains: z.array(z.string()).max(50).optional(),
  excludeDomains: z.array(z.string()).max(50).optional(),
});

export const fetchInputSchema = z.object({
  url: z.string().url(),
  backend: z.enum(['auto', 'direct', 'crawl4ai', 'camofox', 'cloakbrowser']).default('auto'),
  maxCharacters: z.number().int().min(1000).max(200000).default(50000),
  includeLinks: z.boolean().default(true),
  query: z.string().min(1).max(2000).optional(),
  preferCrawl4ai: z.boolean().default(false),
});

export const researchInputSchema = z.object({
  query: z.string().min(1).max(2000),
  maxSources: z.number().int().min(1).max(20).default(6),
  maxCharactersPerSource: z.number().int().min(1000).max(100000).default(30000),
  language: z.string().min(2).max(32).default('en'),
  categories: z.array(z.string()).max(10).optional(),
  timeRange: z.enum(['day', 'week', 'month', 'year']).optional(),
  includeDomains: z.array(z.string()).max(50).optional(),
  excludeDomains: z.array(z.string()).max(50).optional(),
});

export type SearchInput = z.infer<typeof searchInputSchema>;
export type FetchInput = z.infer<typeof fetchInputSchema>;
export type ResearchInput = z.infer<typeof researchInputSchema>;

type SearchOptionFields = {
  maxResults?: number | undefined;
  language?: string | undefined;
  categories?: string[] | undefined;
  timeRange?: 'day' | 'week' | 'month' | 'year' | undefined;
  includeDomains?: string[] | undefined;
  excludeDomains?: string[] | undefined;
};

export function toSearchOptions(input: SearchOptionFields): SearchOptions {
  return {
    ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}),
    ...(input.language !== undefined ? { language: input.language } : {}),
    ...(input.categories ? { categories: input.categories } : {}),
    ...(input.timeRange ? { timeRange: input.timeRange } : {}),
    ...(input.includeDomains ? { includeDomains: input.includeDomains } : {}),
    ...(input.excludeDomains ? { excludeDomains: input.excludeDomains } : {}),
  };
}

export function toFetchOptions(input: FetchInput): FetchOptions {
  return {
    backend: input.backend,
    maxCharacters: input.maxCharacters,
    includeLinks: input.includeLinks,
    ...(input.query ? { query: input.query } : {}),
    ...(input.preferCrawl4ai ? { preferCrawl4ai: input.preferCrawl4ai } : {}),
  };
}

export function toResearchOptions(input: ResearchInput): SearchOptions & { maxSources?: number; maxCharactersPerSource?: number } {
  return {
    ...toSearchOptions(input),
    ...(input.maxSources !== undefined ? { maxSources: input.maxSources } : {}),
    ...(input.maxCharactersPerSource !== undefined ? { maxCharactersPerSource: input.maxCharactersPerSource } : {}),
  };
}
