import http from 'node:http';

const port = Number(process.env.CANARY_PORT ?? '18080');
const hits = [];

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function text(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' });
    response.end();
    return;
  }

  if (url.pathname === '/healthz') {
    text(response, 200, 'ok\n');
    return;
  }

  if (url.pathname === '/counts') {
    json(response, 200, { count: hits.length, hits: hits.slice() });
    return;
  }

  if (url.pathname.startsWith('/hit/')) {
    const probeId = url.pathname.slice('/hit/'.length) || 'unknown';
    hits.push({ probeId, path: url.pathname, at: new Date().toISOString() });
    text(response, 200, 'recorded\n');
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end('not found\n');
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`egress-canary listening on 0.0.0.0:${port}\n`);
});
