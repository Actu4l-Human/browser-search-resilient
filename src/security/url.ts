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
  'metadata.google.internal',
  'metadata.google.internal.',
  'instance-data.pai.googleapis.com',
  'instance-data.pai.googleapis.com.',
]);

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
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

export function isBlockedAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? address.toLowerCase();
  const family = isIP(normalized);
  if (family === 4) return BLOCKED_V4.some(([network, prefix]) => inCidr4(normalized, network, prefix));
  if (family === 6) {
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('ff')) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isBlockedAddress(mapped[1]!) : false;
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
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) throw new SecurityPolicyError(`Blocked hostname: ${host}`);
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home')) {
    throw new SecurityPolicyError(`Blocked internal hostname: ${host}`);
  }
  if (isIP(host) && isBlockedAddress(host)) throw new SecurityPolicyError(`Blocked IP address: ${host}`);
  return url;
}

export async function resolvePublicUrl(raw: string): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  const url = parsePublicUrl(raw);
  const literalFamily = isIP(url.hostname);
  if (literalFamily) {
    const address = url.hostname;
    if (isBlockedAddress(address)) throw new SecurityPolicyError(`Blocked IP address: ${address}`);
    return { url, addresses: [{ address, family: literalFamily as 4 | 6 }] };
  }
  const records = await lookup(url.hostname, { all: true, verbatim: true });
  if (records.length === 0) throw new Error(`DNS returned no addresses for ${url.hostname}`);
  const addresses = records.map((record: { address: string; family: number }) => ({ address: record.address, family: record.family as 4 | 6 }));
  const blocked = addresses.find((record: ResolvedAddress) => isBlockedAddress(record.address));
  if (blocked) throw new SecurityPolicyError(`DNS resolved ${url.hostname} to blocked address ${blocked.address}`);
  return { url, addresses };
}
