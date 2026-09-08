import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { execFile as execFileCallback } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve('tsx')).href;

async function createListener(
  responder: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<{ url: string; hits: string[]; close(): Promise<void> }> {
  const hits: string[] = [];
  const server = http.createServer((request, response) => {
    hits.push(request.url ?? '');
    responder(request, response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start control listener');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

interface StalledDevtoolsListener {
  url: string;
  hits: string[];
  methods: string[];
  upgrades: number;
  close(): Promise<void>;
}

function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const header =
    payload.length < 126
      ? Buffer.allocUnsafe(2)
      : payload.length < 0x1_0000
        ? Buffer.allocUnsafe(4)
        : Buffer.allocUnsafe(10);
  header[0] = 0x80 | (opcode & 0x0f);
  if (payload.length < 126) {
    header[1] = payload.length;
  } else if (payload.length < 0x1_0000) {
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeWsText(value: string): Buffer {
  return encodeWsFrame(0x1, Buffer.from(value));
}

function readWsFrame(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | undefined {
  if (buffer.length < 2) return undefined;
  const first = buffer[0]!;
  const second = buffer[1]!;
  const masked = (second & 0x80) !== 0;
  let payloadLength = second & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) return undefined;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return undefined;
    const length = Number(buffer.readBigUInt64BE(2));
    if (!Number.isSafeInteger(length)) throw new Error('WebSocket frame too large');
    payloadLength = length;
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + payloadLength) return undefined;
  const opcode = first & 0x0f;
  const payload = Buffer.allocUnsafe(payloadLength);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    for (let index = 0; index < payloadLength; index += 1) {
      payload[index] = buffer[offset + index]! ^ mask[index & 3]!;
    }
  } else {
    buffer.copy(payload, 0, offset, offset + payloadLength);
  }
  return { opcode, payload, consumed: offset + payloadLength };
}

async function createStalledDevtoolsListener(): Promise<StalledDevtoolsListener> {
  const hits: string[] = [];
  const methods: string[] = [];
  let upgrades = 0;
  const sockets = new Set<Duplex>();
  const server = http.createServer((request, response) => {
    hits.push(request.url ?? '');
    if ((request.url ?? '').startsWith('/json/version')) {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ browser: 'fake', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/fake' }));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  server.on('upgrade', (request, socket) => {
    upgrades += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n',
    );

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = readWsFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.consumed);
        if (frame.opcode === 0x8) {
          socket.end();
          break;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeWsFrame(0xA, frame.payload));
          continue;
        }
        if (frame.opcode !== 0x1) continue;
        const text = frame.payload.toString('utf8');
        const message = JSON.parse(text) as { id?: number; method?: string };
        if (message.method) methods.push(message.method);
        if (!message.id || !message.method) continue;
        if (message.method === 'Target.createBrowserContext' || message.method === 'Browser.createBrowserContext') {
          continue;
        }
        socket.write(
          encodeWsText(
            JSON.stringify(
              message.method === 'Browser.getVersion'
                ? {
                    id: message.id,
                    result: {
                      product: 'Chrome/124.0.0.0',
                      protocolVersion: '1.3',
                      revision: '@',
                      userAgent: 'Mozilla/5.0',
                    },
                  }
                : { id: message.id, result: {} },
            ),
          ),
        );
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start stalled DevTools listener');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    methods,
    get upgrades() {
      return upgrades;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
test('stalled CDP connect returns after websocket upgrade and before the deadline', async () => {
  const listener = await createStalledDevtoolsListener();
  const started = Date.now();

  try {
    const result = (await runFetchObscura('https://example.com/', {
      OBSCURA_ENABLED: 'true',
      OBSCURA_URL: listener.url,
      BROWSER_TIMEOUT_MS: '1000',
      CHALLENGE_WAIT_MS: '1000',
    })) as { outcome: string; elapsedMs: number; reason?: string };

    assert.equal(result.outcome, 'network_error');
    assert.equal(listener.hits.some((path) => path.startsWith('/json/version')), true);
    assert.equal(listener.upgrades > 0, true);
    assert.equal(listener.methods.some((method) => method.includes('createBrowserContext')), true);
    assert.equal(result.elapsedMs >= 9_000, true);
    assert.equal(result.elapsedMs <= 15_000, true);
    assert.equal(Date.now() - started >= 9_000, true);
    assert.equal(Date.now() - started <= 15_000, true);
  } finally {
    await listener.close();
  }
});

async function runFetchObscura(targetUrl: string, env: Record<string, string>): Promise<unknown> {
  // Dynamic import is required in the child process so OBSCURA_* env values
  // are present before src/config.ts evaluates.
  const script = `
    const { fetchObscura } = await import('./src/backends/obscura.ts');
    const result = await fetchObscura(process.env.TARGET_URL, 2000, true);
    process.stdout.write(JSON.stringify(result));
  `;
  const { stdout } = await execFile(
    process.execPath,
    ['--import', tsxLoader, '--input-type=module', '-e', script],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TARGET_URL: targetUrl,
        ...env,
      },
      timeout: 30_000,
      maxBuffer: 10_000_000,
    },
  );
  return JSON.parse(stdout.trim());
}

test('disabled Obscura returns a network error without contacting CDP', async () => {
  const listener = await createListener((_request, response) => {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ browser: 'fake', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/fake' }));
  });

  try {
    const result = (await runFetchObscura('https://1.1.1.1/', {
      OBSCURA_ENABLED: 'false',
      OBSCURA_URL: listener.url,
    })) as { outcome: string; reason?: string };

    assert.equal(result.outcome, 'network_error');
    assert.equal(result.reason, 'Obscura backend is disabled');
    assert.equal(listener.hits.length, 0);
  } finally {
    await listener.close();
  }
});

test('private URLs are denied before Obscura contact', async () => {
  const listener = await createListener((_request, response) => {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ browser: 'fake', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/fake' }));
  });

  try {
    const result = (await runFetchObscura('http://127.0.0.1/', {
      OBSCURA_ENABLED: 'true',
      OBSCURA_URL: listener.url,
    })) as { outcome: string };

    assert.equal(result.outcome, 'policy_denied');
    assert.equal(listener.hits.length, 0);
  } finally {
    await listener.close();
  }
});

test('connection failures surface as network errors after the CDP version probe', async () => {
  const listener = await createListener((request, response) => {
    if ((request.url ?? '').startsWith('/json/version')) {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ browser: 'fake', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/fake' }));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });

  try {
    const result = (await runFetchObscura('https://1.1.1.1/', {
      OBSCURA_ENABLED: 'true',
      OBSCURA_URL: listener.url,
    })) as { outcome: string };

    assert.equal(result.outcome, 'network_error');
    assert.equal(listener.hits.some((path) => path.startsWith('/json/version')), true);
  } finally {
    await listener.close();
  }
});
