import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { STACK_PROFILES } from './corpus.mjs';

export const BACKEND_CHAINS = {
  baseline: ['direct', 'crawl4ai', 'camofox', 'cloakbrowser'],
  'add-obscura': ['direct', 'crawl4ai', 'obscura', 'camofox', 'cloakbrowser'],
  'add-scrapling': ['direct', 'crawl4ai', 'scrapling', 'camofox', 'cloakbrowser'],
  'replace-obscura': ['direct', 'crawl4ai', 'obscura'],
  'replace-scrapling': ['direct', 'crawl4ai', 'scrapling'],
};

export const SERVICE_CHAINS = {
  baseline: ['browser-search', 'egress-proxy', 'searxng', 'crawl4ai', 'camofox', 'egress-canary'],
  'add-obscura': ['browser-search', 'egress-proxy', 'searxng', 'crawl4ai', 'camofox', 'obscura', 'egress-canary'],
  'add-scrapling': ['browser-search', 'egress-proxy', 'searxng', 'crawl4ai', 'camofox', 'scrapling', 'egress-canary'],
  'replace-obscura': ['browser-search', 'egress-proxy', 'searxng', 'crawl4ai', 'obscura', 'egress-canary'],
  'replace-scrapling': ['browser-search', 'egress-proxy', 'searxng', 'crawl4ai', 'scrapling', 'egress-canary'],
};

export function requiredBackendsForProfile(profile) {
  const chain = BACKEND_CHAINS[profile];
  if (!chain) throw new Error(`unknown profile ${profile}`);
  return [...chain];
}

export function requiredServicesForProfile(profile) {
  const chain = SERVICE_CHAINS[profile];
  if (!chain) throw new Error(`unknown profile ${profile}`);
  return [...chain];
}

export function profileRuntimeServices(profile) {
  return requiredServicesForProfile(profile);
}

export function profileHeavyServices(profile) {
  switch (profile) {
    case 'baseline':
      return ['browser-search', 'crawl4ai', 'camofox'];
    case 'add-obscura':
      return ['browser-search', 'crawl4ai', 'camofox', 'obscura'];
    case 'add-scrapling':
      return ['browser-search', 'crawl4ai', 'camofox', 'scrapling'];
    case 'replace-obscura':
      return ['browser-search', 'crawl4ai', 'obscura'];
    case 'replace-scrapling':
      return ['browser-search', 'crawl4ai', 'scrapling'];
    default:
      throw new Error(`unknown profile ${profile}`);
  }
}

export function resourceEnvelope(profile) {
  const totalCpuMilli = 4_000;
  const totalMemoryMiB = 8_192;
  const reserve = {
    'egress-proxy': { cpuMilli: 250, memoryMiB: 256 },
    searxng: { cpuMilli: 250, memoryMiB: 256 },
  };
  const heavyServices = profileHeavyServices(profile);
  const remainingCpuMilli = totalCpuMilli - reserve['egress-proxy'].cpuMilli - reserve.searxng.cpuMilli;
  const remainingMemoryMiB = totalMemoryMiB - reserve['egress-proxy'].memoryMiB - reserve.searxng.memoryMiB;
  const heavyCount = heavyServices.length;
  const cpuBase = Math.floor(remainingCpuMilli / heavyCount);
  const cpuRemainder = remainingCpuMilli - cpuBase * heavyCount;
  const memoryBase = Math.floor(remainingMemoryMiB / heavyCount);
  const memoryRemainder = remainingMemoryMiB - memoryBase * heavyCount;

  const performance = {
    'egress-proxy': { ...reserve['egress-proxy'] },
    searxng: { ...reserve.searxng },
  };

  for (const [index, service] of heavyServices.entries()) {
    performance[service] = {
      cpuMilli: cpuBase + (service === 'browser-search' ? cpuRemainder : 0),
      memoryMiB: memoryBase + (service === 'browser-search' ? memoryRemainder : 0),
      role: service === 'browser-search' ? 'app' : service,
    };
    if (index > 0 && service !== 'browser-search') {
      performance[service].role = service;
    }
  }

  const canary = { cpuMilli: 50, memoryMiB: 64 };
  const sumPerformance = Object.values(performance).reduce(
    (acc, entry) => ({ cpuMilli: acc.cpuMilli + entry.cpuMilli, memoryMiB: acc.memoryMiB + entry.memoryMiB }),
    { cpuMilli: 0, memoryMiB: 0 },
  );

  return {
    total: { cpuMilli: totalCpuMilli, memoryMiB: totalMemoryMiB },
    performance,
    diagnostic: { 'egress-canary': canary },
    sumPerformance,
    sumWithDiagnostic: {
      cpuMilli: sumPerformance.cpuMilli + canary.cpuMilli,
      memoryMiB: sumPerformance.memoryMiB + canary.memoryMiB,
    },
  };
}

export function diagnosticTrackCaps(backend) {
  const proxy = { cpuMilli: 250, memoryMiB: 256 };
  if (backend === 'cloakbrowser') {
    return {
      backend,
      app: { cpuMilli: 2_000, memoryMiB: 2_048 },
      engine: null,
      proxy,
      total: { cpuMilli: 2_250, memoryMiB: 2_304 },
    };
  }

  if (backend === 'camofox' || backend === 'obscura' || backend === 'scrapling') {
    return {
      backend,
      app: { cpuMilli: 500, memoryMiB: 512 },
      engine: { cpuMilli: 1_500, memoryMiB: 1_536 },
      proxy,
      total: { cpuMilli: 2_250, memoryMiB: 2_304 },
    };
  }

  throw new Error(`unknown diagnostic backend ${backend}`);
}


function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function experimentalNetwork(profile) {
  switch (profile) {
    case 'add-obscura':
    case 'replace-obscura':
      return 'obscura-control';
    case 'add-scrapling':
    case 'replace-scrapling':
      return 'scrapling-control';
    default:
      return null;
  }
}

function serviceNetworks(profile, name) {
  const experimental = experimentalNetwork(profile);
  switch (name) {
    case 'browser-search': {
      const networks = {
        'crawl4ai-control': {},
        'searxng-control': {},
        internet: {},
      };
      if (profile === 'baseline' || profile === 'add-obscura' || profile === 'add-scrapling') {
        networks['camofox-control'] = {};
      }
      if (experimental) networks[experimental] = {};
      return networks;
    }
    case 'egress-proxy': {
      const networks = {
        'crawl4ai-control': {},
        internet: {},
      };
      if (profile === 'baseline' || profile === 'add-obscura' || profile === 'add-scrapling') {
        networks['camofox-control'] = {};
      }
      if (experimental) networks[experimental] = {};
      return networks;
    }
    case 'searxng':
      return { 'searxng-control': {}, internet: {} };
    case 'crawl4ai':
      return { 'crawl4ai-control': {} };
    case 'camofox':
      return { 'camofox-control': {} };
    case 'obscura':
      return { 'obscura-control': {} };
    case 'scrapling':
      return { 'scrapling-control': {} };
    case 'egress-canary':
      return { 'canary-control': {} };
    default:
      return {};
  }
}

function comparisonEnv(profile, tuning) {
  const browserTimeoutMs = String(tuning.browserTimeoutMs ?? 20_000);
  const browserSettleMs = String(tuning.browserSettleMs ?? 0);
  return {
    FETCH_STACK_PROFILE: profile,
    BROWSER_SEARCH_PORT: String(tuning.browserSearchPort ?? 8088),
    BROWSER_TIMEOUT_MS: browserTimeoutMs,
    BROWSER_SETTLE_MS: browserSettleMs,
    CRAWL4AI_TIMEOUT_MS: browserTimeoutMs,
    CRAWL4AI_PAGE_TIMEOUT_MS: browserTimeoutMs,
    CAMOFOX_ENABLED: String(profile === 'baseline' || profile === 'add-obscura' || profile === 'add-scrapling'),
    CLOAK_ENABLED: String(profile === 'baseline' || profile === 'add-obscura' || profile === 'add-scrapling'),
    OBSCURA_ENABLED: String(profile === 'add-obscura' || profile === 'replace-obscura'),
    SCRAPLING_ENABLED: String(profile === 'add-scrapling' || profile === 'replace-scrapling'),
  };
}

function serviceTuningEnv(name, tuning) {
  const browserTimeoutMs = String(tuning.browserTimeoutMs ?? 20_000);
  const browserSettleMs = String(tuning.browserSettleMs ?? 0);
  switch (name) {
    case 'crawl4ai':
      return {
        CRAWL4AI_TIMEOUT_MS: browserTimeoutMs,
        CRAWL4AI_PAGE_TIMEOUT_MS: browserTimeoutMs,
        BROWSER_SETTLE_MS: browserSettleMs,
      };
    case 'obscura':
      return {
        OBSCURA_NAV_TIMEOUT_MS: browserTimeoutMs,
        OBSCURA_SCRIPT_DEADLINE_MS: browserTimeoutMs,
        OBSCURA_CDP_COMMAND_TIMEOUT_MS: String(Number(browserTimeoutMs) + 5000),
      };
    case 'scrapling':
      return {
        BROWSER_TIMEOUT_MS: browserTimeoutMs,
        BROWSER_SETTLE_MS: browserSettleMs,
        SCRAPLING_TIMEOUT_MS: browserTimeoutMs,
        SCRAPLING_SETTLE_MS: browserSettleMs,
        SCRAPLING_WAIT_MS: '0',
      };
    default:
      return {};
  }
}

function scopeVolumeName(name, runId) {
  if (!runId) return name;
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return name;
  return `compare-${runId}-${name}`;
}


function applyResourceLimit(service, limit) {
  const cpu = Number((limit.cpuMilli / 1000).toFixed(3));
  const memory = `${limit.memoryMiB}m`;
  service.cpus = cpu;
  service.mem_limit = memory;
}

function resolveVolumeSpec(spec, baseDir) {
  if (!baseDir || typeof spec !== 'string') return spec;
  const index = spec.indexOf(':');
  if (index <= 0) return spec;
  const source = spec.slice(0, index);
  if (/^[A-Za-z]:[\\/]/.test(source) || source.startsWith('/') || source.startsWith('\\\\')) return spec;
  if (!source.startsWith('.') && !source.includes('/')) return spec;
  return `${resolve(baseDir, source)}${spec.slice(index)}`;
}

function normalizeBuildContext(build, baseDir) {
  if (!baseDir || !build) return build;
  if (typeof build === 'string') return resolve(baseDir, build);
  if (typeof build === 'object' && build.context) {
    return { ...build, context: resolve(baseDir, build.context) };
  }
  return build;
}

function splitVolumeSpec(spec) {
  if (typeof spec !== 'string') return { source: '', suffix: '' };
  const firstColon = spec.indexOf(':');
  if (firstColon < 0) return { source: spec, suffix: '' };
  if (/^[A-Za-z]:[\\/]/.test(spec)) {
    const secondColon = spec.indexOf(':', 2);
    if (secondColon < 0) return { source: spec, suffix: '' };
    return { source: spec.slice(0, secondColon), suffix: spec.slice(secondColon) };
  }
  return { source: spec.slice(0, firstColon), suffix: spec.slice(firstColon) };
}

function isNamedVolumeSource(source) {
  if (!source) return false;
  if (source.startsWith('/') || source.startsWith('\\') || source.startsWith('.') || source.startsWith('~')) return false;
  if (/^[A-Za-z]:[\\/]/.test(source)) return false;
  return !source.includes('/') && !source.includes('\\');
}

function scopeResolvedVolumeSpec(spec, baseDir, runId, usedVolumes) {
  if (typeof spec !== 'string') return spec;
  const resolved = resolveVolumeSpec(spec, baseDir);
  const { source, suffix } = splitVolumeSpec(resolved);
  if (!isNamedVolumeSource(source)) return resolved;
  const scoped = scopeVolumeName(source, runId);
  if (usedVolumes) usedVolumes.add(scoped);
  return `${scoped}${suffix}`;
}

export function composeForProfile(template, profile, tuning = {}, images = {}, baseDir = '', runId = '') {
  const active = new Set(requiredServicesForProfile(profile));
  const envelope = resourceEnvelope(profile);
  const out = clone(template);
  const services = {};
  const usedVolumes = new Set();
  const browserSearchPort = Number(tuning.browserSearchPort ?? 8088);
  for (const [name, definition] of Object.entries(template.services ?? {})) {
    if (!active.has(name)) continue;
    const service = clone(definition);
    service.environment = {
      ...(service.environment ?? {}),
      ...(name === 'browser-search' ? comparisonEnv(profile, tuning) : {}),
      ...serviceTuningEnv(name, tuning),
    };
    if (name === 'browser-search' && Array.isArray(service.ports)) {
      service.ports = service.ports.map((entry) => (
        typeof entry === 'string' ? entry.replace('${BROWSER_SEARCH_PORT:-8088}', String(browserSearchPort)) : entry
      ));
    }
    if (Array.isArray(service.volumes)) {
      service.volumes = service.volumes.map((entry) => scopeResolvedVolumeSpec(entry, baseDir, runId, usedVolumes));
    }
    if (baseDir) {
      service.build = normalizeBuildContext(service.build, baseDir);
    }
    const limit = envelope.performance[name] ?? envelope.diagnostic[name];
    if (limit) applyResourceLimit(service, limit);
    service.networks = serviceNetworks(profile, name);
    if (images[name]) {
      service.image = images[name];
      delete service.build;
    }
    if (service.depends_on) {
      const nextDepends = {};
      for (const [depName, depValue] of Object.entries(service.depends_on)) {
        if (!active.has(depName)) continue;
        nextDepends[depName] = depValue;
      }
      if (Object.keys(nextDepends).length > 0) {
        service.depends_on = nextDepends;
      } else {
        delete service.depends_on;
      }
    }
    services[name] = service;
  }
  out.services = services;
  const networks = {};
  for (const service of Object.values(services)) {
    for (const name of Object.keys(service.networks ?? {})) {
      if (template.networks?.[name]) networks[name] = clone(template.networks[name]);
    }
  }
  out.networks = networks;
  if (template.volumes) {
    const volumes = {};
    for (const [name, spec] of Object.entries(template.volumes)) {
      const scopedName = scopeVolumeName(name, runId);
      if (usedVolumes.size > 0 && !usedVolumes.has(scopedName)) continue;
      volumes[scopedName] = clone(spec);
    }
    if (Object.keys(volumes).length > 0) {
      out.volumes = volumes;
    } else {
      delete out.volumes;
    }
  }
  return out;
}

function diagnosticServiceNames(backend) {
  if (backend === 'cloakbrowser') {
    return ['browser-search', 'egress-proxy', 'egress-canary'];
  }
  if (backend === 'camofox' || backend === 'obscura' || backend === 'scrapling') {
    return ['browser-search', 'egress-proxy', backend, 'egress-canary'];
  }
  throw new Error(`unknown diagnostic backend ${backend}`);
}

function diagnosticServiceLimit(backend, name) {
  if (name === 'egress-proxy') return { cpuMilli: 250, memoryMiB: 256 };
  if (name === 'egress-canary') return { cpuMilli: 50, memoryMiB: 64 };
  if (backend === 'cloakbrowser' && name === 'browser-search') return { cpuMilli: 2000, memoryMiB: 2048 };
  if (name === 'browser-search') return { cpuMilli: 500, memoryMiB: 512 };
  if (name === backend) return { cpuMilli: 1500, memoryMiB: 1536 };
  return null;
}

export function diagnosticComposeForBackend(template, profile, backend, tuning = {}, images = {}, baseDir = '', runId = '') {
  const active = new Set(diagnosticServiceNames(backend));
  const out = clone(template);
  const services = {};
  const usedVolumes = new Set();
  const browserTimeoutMs = String(tuning.browserTimeoutMs ?? 20_000);
  const browserSettleMs = String(tuning.browserSettleMs ?? 0);

  for (const [name, definition] of Object.entries(template.services ?? {})) {
    if (!active.has(name)) continue;
    const service = clone(definition);
    service.environment = {
      ...(service.environment ?? {}),
      ...(name === 'browser-search' ? {
        FETCH_STACK_PROFILE: 'baseline',
        BROWSER_SEARCH_PORT: String(tuning.browserSearchPort ?? 8088),
        BROWSER_TIMEOUT_MS: browserTimeoutMs,
        BROWSER_SETTLE_MS: browserSettleMs,
        CRAWL4AI_ENABLED: 'false',
        CAMOFOX_ENABLED: String(backend === 'camofox'),
        CLOAK_ENABLED: String(backend === 'cloakbrowser'),
        OBSCURA_ENABLED: String(backend === 'obscura'),
        SCRAPLING_ENABLED: String(backend === 'scrapling'),
      } : {}),
      ...serviceTuningEnv(name, tuning),
    };
    if (name === 'browser-search' && Array.isArray(service.ports)) {
      service.ports = service.ports.map((entry) => (
        typeof entry === 'string' ? entry.replace('${BROWSER_SEARCH_PORT:-8088}', String(tuning.browserSearchPort ?? 8088)) : entry
      ));
    }
    if (Array.isArray(service.volumes)) {
      service.volumes = service.volumes.map((entry) => scopeResolvedVolumeSpec(entry, baseDir, runId, usedVolumes));
    }
    if (baseDir) {
      service.build = normalizeBuildContext(service.build, baseDir);
    }
    const limit = diagnosticServiceLimit(backend, name);
    if (limit) applyResourceLimit(service, limit);
    service.networks = serviceNetworks(profile, name);
    if (images[name]) {
      service.image = images[name];
      delete service.build;
    }
    if (service.depends_on) {
      const nextDepends = {};
      for (const [depName, depValue] of Object.entries(service.depends_on)) {
        if (!active.has(depName)) continue;
        nextDepends[depName] = depValue;
      }
      if (Object.keys(nextDepends).length > 0) {
        service.depends_on = nextDepends;
      } else {
        delete service.depends_on;
      }
    }
    services[name] = service;
  }

  out.services = services;
  const networks = {};
  for (const service of Object.values(services)) {
    for (const name of Object.keys(service.networks ?? {})) {
      if (template.networks?.[name]) networks[name] = clone(template.networks[name]);
    }
  }
  out.networks = networks;
  if (template.volumes) {
    const volumes = {};
    for (const [name, spec] of Object.entries(template.volumes)) {
      const scopedName = scopeVolumeName(name, runId);
      if (usedVolumes.size > 0 && !usedVolumes.has(scopedName)) continue;
      volumes[scopedName] = clone(spec);
    }
    if (Object.keys(volumes).length > 0) {
      out.volumes = volumes;
    } else {
      delete out.volumes;
    }
  }
  return out;
}




export async function loadComposeTemplate(filePath) {
  const text = await readFile(filePath, 'utf8');
  return JSON.parse(text);
}

export async function writeComposeProfile({ templatePath, profile, tuning = {}, images = {}, outPath, baseDir = '', runId = '' }) {
  const template = await loadComposeTemplate(templatePath);
  const descriptor = composeForProfile(template, profile, tuning, images, baseDir, runId);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  return descriptor;
}

export function profileOrder() {
  return [...STACK_PROFILES];
}
