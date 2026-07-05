export type BackendName = 'direct' | 'camofox' | 'cloakbrowser';

export type FetchOutcome =
  | 'success'
  | 'js_required'
  | 'antibot_challenge'
  | 'rate_limited'
  | 'authentication_required'
  | 'human_verification_required'
  | 'policy_denied'
  | 'not_found'
  | 'unsupported_content_type'
  | 'empty_content'
  | 'network_error';

export interface LinkResult {
  text: string;
  url: string;
}

export interface FetchAttempt {
  backend: BackendName;
  outcome: FetchOutcome;
  url: string;
  finalUrl?: string;
  title?: string;
  content?: string;
  links?: LinkResult[];
  contentType?: string;
  httpStatus?: number;
  elapsedMs: number;
  reason?: string;
  truncated?: boolean;
  challenge?: string;
}

export interface FetchResponse {
  status: 'success' | 'failed';
  requestedUrl: string;
  result: FetchAttempt;
  attempts: FetchAttempt[];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
  publishedDate?: string;
  score?: number;
}

export interface SearchAttempt {
  backend: 'searxng' | BackendName;
  outcome: 'success' | 'failed';
  elapsedMs: number;
  reason?: string;
}

export interface SearchResponse {
  status: 'success' | 'failed';
  query: string;
  results: SearchResult[];
  attempts: SearchAttempt[];
}

export interface FetchOptions {
  backend?: 'auto' | BackendName;
  maxCharacters?: number;
  includeLinks?: boolean;
}

export interface SearchOptions {
  maxResults?: number;
  language?: string;
  categories?: string[];
  timeRange?: 'day' | 'week' | 'month' | 'year';
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface ResearchResponse {
  status: 'success' | 'partial' | 'failed';
  query: string;
  search: SearchResponse;
  sources: FetchResponse[];
}
