import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { resolvePublicUrl, type ResolvedAddress } from './security/url.js';

const host = process.env.EGRESS_PROXY_HOST ?? '0.0.0.0';
const port = Number.parseInt(process.env.EGRESS_PROXY_PORT ?? '3128', 10);
const connectTimeoutMs = Number.parseInt(process.env.EGRESS_PROXY_CONNECT_TIMEOUT_MS ?? '20000', 10);

function log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ level, message, ...fields, timestamp: new Date().toISOString() })}\n`);
}

function selectedAddress(addresses: ResolvedAddress[]): ResolvedAddress {
  const address = addresses[0];
  if (!address) throw new Error('No validated DNS address available');
  return address;
}

function cleanHeaders(headers: IncomingHttpHeaders, target: URL): IncomingHttpHeaders {
  const result = { ...headers };
  delete result['proxy-authorization'];
  delete result['proxy-connection'];
  result.host = target.host;
  result.connection = 'close';
  return result;
}

function replyError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
  response.end(`${message}\n`);
}

async function proxyHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.url === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"status":"ok"}\n');
    return;
  }

  const rawUrl = request.url ?? '';
  const targetUrl = /^https?:\/\//i.test(rawUrl)
    ? rawUrl
    : `http://${request.headers.host ?? ''}${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}`;

  try {
    const resolved = await resolvePublicUrl(targetUrl);
    const target = resolved.url;
    const address = selectedAddress(resolved.addresses);
    const transport = target.protocol === 'https:' ? https : http;

    const upstream = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers: cleanHeaders(request.headers, target),
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        servername: target.hostname.replace(/^\[|\]$/g, ''),
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );

    upstream.setTimeout(connectTimeoutMs, () => upstream.destroy(new Error('Upstream request timed out')));
    upstream.on('error', (error) => {
      log('warn', 'HTTP proxy upstream failed', { target: target.origin, error: error.message });
      replyError(response, 502, 'Bad gateway');
    });
    request.pipe(upstream);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('warn', 'HTTP proxy destination denied', { target: targetUrl, reason: message });
    replyError(response, 403, 'Destination denied by egress policy');
  }
}

function writeConnectError(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

async function proxyConnect(request: IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
  const authority = request.url ?? '';
  try {
    const target = new URL(`https://${authority}`);
    const destinationPort = target.port ? Number.parseInt(target.port, 10) : 443;
    if (!Number.isInteger(destinationPort) || destinationPort < 1 || destinationPort > 65535) {
      throw new Error('Invalid CONNECT port');
    }

    const resolved = await resolvePublicUrl(target.toString());
    const address = selectedAddress(resolved.addresses);
    const upstreamSocket = net.connect({ host: address.address, port: destinationPort });
    upstreamSocket.setTimeout(connectTimeoutMs, () => upstreamSocket.destroy(new Error('CONNECT timed out')));

    upstreamSocket.once('connect', () => {
      upstreamSocket.setTimeout(0);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: resilient-browser-egress\r\n\r\n');
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.once('error', (error) => {
      log('warn', 'CONNECT upstream failed', { authority, error: error.message });
      writeConnectError(clientSocket, 502, 'Bad Gateway');
    });
    clientSocket.once('error', () => upstreamSocket.destroy());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('warn', 'CONNECT destination denied', { authority, reason: message });
    writeConnectError(clientSocket, 403, 'Forbidden');
  }
}

const server = http.createServer((request, response) => {
  void proxyHttp(request, response);
});
server.on('connect', (request, socket, head) => {
  void proxyConnect(request, socket, head);
});
server.on('clientError', (_error, socket) => writeConnectError(socket, 400, 'Bad Request'));

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, () => resolve());
});
log('info', 'SSRF-filtering egress proxy listening', { host, port });

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
