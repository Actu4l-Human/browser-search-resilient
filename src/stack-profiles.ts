import type { BackendName } from './types.js';

export const stackProfiles = ['baseline', 'add-obscura', 'add-scrapling', 'replace-obscura', 'replace-scrapling'] as const;

export type StackProfile = (typeof stackProfiles)[number];

export const stackProfileChains = {
  baseline: ['direct', 'crawl4ai', 'camofox', 'cloakbrowser'],
  'add-obscura': ['direct', 'crawl4ai', 'obscura', 'camofox', 'cloakbrowser'],
  'add-scrapling': ['direct', 'crawl4ai', 'scrapling', 'camofox', 'cloakbrowser'],
  'replace-obscura': ['direct', 'crawl4ai', 'obscura'],
  'replace-scrapling': ['direct', 'crawl4ai', 'scrapling'],
} as const satisfies Record<StackProfile, readonly BackendName[]>;

export function isStackProfile(value: string): value is StackProfile {
  return (stackProfiles as readonly string[]).includes(value);
}

export function stackProfileRequiredBackends(profile: StackProfile): readonly BackendName[] {
  return stackProfileChains[profile];
}

export function stackProfileRequiredServices(profile: StackProfile): readonly Exclude<BackendName, 'direct'>[] {
  return stackProfileChains[profile].filter((backend): backend is Exclude<BackendName, 'direct'> => backend !== 'direct');
}
