import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SecurityPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityPolicyError';
  }
}

export function isSecurityPolicyError(error: unknown): error is SecurityPolicyError {
  return error instanceof SecurityPolicyError;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.',
  'metadata',
  'metadata.google.internal',
  'metadata.google.internal.',
  'instance-data',
  'instance-data.ec2.internal',
  'instance-data.pai.googleapis.com',
  'instance-data.pai.googleapis.com.',
  'metadata.azure.com',
  'metadata.aws.internal',
]);

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function intToIpv4(value: number): string {
  const normalized = value >>> 0;
  return [normalized >>> 24, (normalized >>> 16) & 0xff, (normalized >>> 8) & 0xff, normalized & 0xff].join('.');
}

function inCidr4(ip: string, network: string, prefix: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const networkInt = ipv4ToInt(network);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (networkInt & mask);
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const IPV6_BIG = (1n << 128n) - 1n;

function groupCount(group: string): number {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(group) ? 2 : 1;
}

function ipv6ToBigInt(ip: string): bigint {
  const scoped = ip.split('%')[0]!.toLowerCase();
  let segments: string[];
  if (scoped.includes('::')) {
    const halves = scoped.split('::');
    if (halves.length !== 2) throw new Error(`Invalid IPv6 address: ${ip}`);
    const left = halves[0] ? halves[0]!.split(':') : [];
    const right = halves[1] ? halves[1]!.split(':') : [];
    const used = [...left, ...right].reduce((sum, group) => sum + groupCount(group), 0);
    const missing = 8 - used;
    if (missing < 0) throw new Error(`Invalid IPv6 address: ${ip}`);
    segments = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  } else {
    segments = scoped.split(':');
  }
  const expanded: string[] = [];
  for (const group of segments) {
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(group)) {
      const v4 = ipv4ToInt(group) >>> 0;
      expanded.push(((v4 >>> 16) & 0xffff).toString(16));
      expanded.push((v4 & 0xffff).toString(16));
    } else {
      expanded.push(group);
    }
  }
  if (expanded.length !== 8) throw new Error(`Invalid IPv6 address: ${ip}`);
  let result = 0n;
  for (const group of expanded) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) throw new Error(`Invalid IPv6 group: ${group}`);
    result = (result << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return result;
}

function inCidr6(ip: string, network: string, prefix: number): boolean {
  const ipInt = ipv6ToBigInt(ip);
  const networkInt = ipv6ToBigInt(network);
  const mask = prefix === 0 ? 0n : (IPV6_BIG << BigInt(128 - prefix)) & IPV6_BIG;
  return (ipInt & mask) === (networkInt & mask);
}

const BLOCKED_V6: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

const EMBEDDED_V4_PREFIXES: Array<[string, number]> = [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['::ffff:0:0:0', 96],
  ['64:ff9b::', 96],
];

function embeddedIpv4(address: string): string | undefined {
  try {
    if (!EMBEDDED_V4_PREFIXES.some(([network, prefix]) => inCidr6(address, network, prefix))) return undefined;
    const value = Number(ipv6ToBigInt(address) & 0xffffffffn);
    return intToIpv4(value);
  } catch {
    return undefined;
  }
}

export function isBlockedAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? address.toLowerCase();
  const family = isIP(normalized);
  if (family === 4) return BLOCKED_V4.some(([network, prefix]) => inCidr4(normalized, network, prefix));
  if (family === 6) {
    const v6Blocked = BLOCKED_V6.some(([network, prefix]) => {
      try {
        return inCidr6(normalized, network, prefix);
      } catch {
        return false;
      }
    });
    if (v6Blocked) return true;
    const v4 = embeddedIpv4(normalized);
    return v4 ? isBlockedAddress(v4) : false;
  }
  return true;
}

export function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SecurityPolicyError('Invalid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new SecurityPolicyError(`Blocked URL scheme: ${url.protocol}`);
  if (url.username || url.password) throw new SecurityPolicyError('Credentials in URLs are not allowed');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(host)) throw new SecurityPolicyError(`Blocked hostname: ${host}`);
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home')) {
    throw new SecurityPolicyError(`Blocked internal hostname: ${host}`);
  }
  if (isIP(host) && isBlockedAddress(host)) throw new SecurityPolicyError(`Blocked IP address: ${host}`);
  return url;
}

export async function resolvePublicUrl(raw: string): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  const url = parsePublicUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    const address = hostname;
    if (isBlockedAddress(address)) throw new SecurityPolicyError(`Blocked IP address: ${address}`);
    return { url, addresses: [{ address, family: literalFamily as 4 | 6 }] };
  }
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) throw new Error(`DNS returned no addresses for ${hostname}`);
  const addresses = records.map((record: { address: string; family: number }) => ({
    address: record.address,
    family: record.family as 4 | 6,
  }));
  const blocked = addresses.find((record: ResolvedAddress) => isBlockedAddress(record.address));
  if (blocked) throw new SecurityPolicyError(`DNS resolved ${hostname} to blocked address ${blocked.address}`);
  return { url, addresses };
}
