import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';

import type { DaemonApi, StatusView } from '../src/api/daemon-api.js';
import { createLocalApiServer, type LocalApiServer } from '../src/api/server.js';
import type { ApiTokenVerifier } from '../src/api/token.js';
import { exceedsOutboundQueue } from '../src/api/ws.js';
import { WS_SUBPROTOCOL } from '../src/api/ws-protocol.js';

const TOKEN = 'w'.repeat(43);
const AUTH = JSON.stringify({ type: 'auth', token: TOKEN });
const URL = 'ws://127.0.0.1:18700/v1/ws';
const HOST = '127.0.0.1:18700';

const status = {
  phase: 'RUNNING',
  pid: 1,
  startedAt: null,
  bootId: 'boot',
  storeOpen: true,
  lockHeld: true,
  personaLifecycleAssembled: true,
  recovery: null,
  scheduler: null,
  components: {},
  capabilities: {},
} as unknown as StatusView;

const verifier: ApiTokenVerifier = { verify: (candidate) => candidate === TOKEN };

function makeApi(): DaemonApi {
  return {
    getStatus: () => status,
    getReadiness: () => ({ ready: true, reason: null }),
    listPersonas: () => [],
    getPersona: () => null,
    createPersona: async () => ({}) as never,
    startPersona: async () => ({}) as never,
    suspendPersona: async () => ({}) as never,
    resumePersona: async () => ({}) as never,
    stopPersona: async () => ({}) as never,
    listEvents: () => [],
    getEvent: () => null,
    listTasks: () => [],
    listSessions: () => [],
  };
}

const servers: LocalApiServer[] = [];
const clients: WebSocket[] = [];

async function makeServer(
  clock?: () => number,
  api: DaemonApi = makeApi(),
): Promise<LocalApiServer> {
  const server = createLocalApiServer({
    api,
    token: verifier,
    readiness: () => ({ ready: true, reason: null }),
    port: 18700,
    ...(clock === undefined ? {} : { clock }),
  });
  await server.listen();
  servers.push(server);
  return server;
}

async function openClient(protocols: string[] = [WS_SUBPROTOCOL]): Promise<WebSocket> {
  const socket = new WebSocket(URL, protocols);
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error('websocket open failed'));
    };
    const cleanup = (): void => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
  });
  return socket;
}

interface MessageQueue {
  next(timeoutMs?: number): Promise<unknown>;
}

function collectMessages(socket: WebSocket): MessageQueue {
  const messages: unknown[] = [];
  const waiters: Array<{
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as unknown;
    const waiter = waiters.shift();
    if (waiter === undefined) {
      messages.push(message);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });

  return {
    next(timeoutMs = 2000): Promise<unknown> {
      if (messages.length > 0) {
        return Promise.resolve(messages.shift());
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            reject(new Error('message timeout'));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

function nextClose(socket: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
    socket.addEventListener(
      'close',
      (event) => {
        clearTimeout(timer);
        resolve({ code: event.code, reason: event.reason });
      },
      { once: true },
    );
  });
}

async function authenticate(socket: WebSocket): Promise<MessageQueue> {
  const messages = collectMessages(socket);
  socket.send(AUTH);
  await messages.next();
  await messages.next();
  return messages;
}

async function closeClient(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  const closed = nextClose(socket, 3000).catch(() => undefined);
  socket.close();
  await closed;
}

interface RawUpgradeResult {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function rawUpgradeHold(path = '/v1/ws', headers: Record<string, string> = {}): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: 18700,
      method: 'GET',
      path,
      headers: {
        Host: HOST,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.once('upgrade', (_response, socket) => {
      socket.on('error', () => undefined);
      resolve(socket);
    });
    req.once('response', (response) => {
      response.resume();
      reject(new Error(`unexpected HTTP ${response.statusCode ?? 0}`));
    });
    req.once('error', reject);
    req.end();
  });
}

function rawUpgrade(
  path = '/v1/ws',
  headers: Record<string, string> = {},
): Promise<RawUpgradeResult> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: 18700,
      method: 'GET',
      path,
      headers: {
        Host: HOST,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.once('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ statusCode: 101, headers: response.headers, body: '' });
    });
    req.once('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body,
        });
      });
      response.resume();
    });
    req.once('error', reject);
    req.end();
  });
}

afterEach(async () => {
  while (clients.length > 0) {
    clients.pop()?.close();
  }
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

describe('WebSocket upgrade and authentication', () => {
  it('serves hello then one authoritative snapshot after first-frame auth', async () => {
    await makeServer();
    const socket = await openClient();
    expect(socket.protocol).toBe(WS_SUBPROTOCOL);
    const messages = collectMessages(socket);
    socket.send(AUTH);

    const hello = (await messages.next()) as Record<string, unknown>;
    expect(hello).toMatchObject({ type: 'hello', protocol: WS_SUBPROTOCOL });
    expect(typeof hello['serverTime']).toBe('number');
    const snapshot = (await messages.next()) as Record<string, unknown>;
    expect(snapshot).toMatchObject({ type: 'snapshot', status });
    expect(JSON.stringify(snapshot)).not.toContain('dataDir');
    expect(JSON.stringify(snapshot)).not.toContain('lockPath');
    socket.close();
  });

  it('requires the exact subprotocol before upgrade', async () => {
    await makeServer();
    expect((await rawUpgrade('/v1/ws', {})).statusCode).toBe(426);
    expect((await rawUpgrade('/v1/ws', { 'Sec-WebSocket-Protocol': 'other' })).statusCode).toBe(
      426,
    );
    expect(
      (await rawUpgrade('/v1/ws', { 'Sec-WebSocket-Protocol': WS_SUBPROTOCOL })).statusCode,
    ).toBe(101);
  });

  it('rejects query tokens and bad Host/Origin before upgrade', async () => {
    await makeServer();
    const query = await rawUpgrade('/v1/ws?token=secret', {
      'Sec-WebSocket-Protocol': WS_SUBPROTOCOL,
    });
    expect(query.statusCode).toBe(400);
    expect(JSON.parse(query.body)).toStrictEqual({
      error: { code: 'invalid_request', message: 'invalid request' },
    });

    const badHost = await rawUpgrade('/v1/ws', {
      Host: 'evil.example',
      'Sec-WebSocket-Protocol': WS_SUBPROTOCOL,
    });
    expect(badHost.statusCode).toBe(403);
    expect(JSON.parse(badHost.body)).toStrictEqual({
      error: { code: 'forbidden', message: 'request forbidden' },
    });
    expect(
      (
        await rawUpgrade('/v1/ws', {
          Origin: 'https://evil.example',
          'Sec-WebSocket-Protocol': WS_SUBPROTOCOL,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await rawUpgrade('/v1/ws', {
          Origin: 'http://127.0.0.1:18701',
          'Sec-WebSocket-Protocol': WS_SUBPROTOCOL,
        })
      ).statusCode,
    ).toBe(101);
  });

  it('keeps normal HTTP /v1/ws subject to HTTP Bearer auth', async () => {
    await makeServer();
    const unauthenticated = await new Promise<number>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port: 18700,
        method: 'GET',
        path: '/v1/ws',
        headers: { Host: HOST },
      });
      req.once('response', (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      req.once('error', reject);
      req.end();
    });
    expect(unauthenticated).toBe(401);
  });

  it('closes with 1008 for a wrong token and 1003 for invalid JSON', async () => {
    await makeServer();
    const wrong = await openClient();
    wrong.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    expect(await nextClose(wrong)).toStrictEqual({ code: 1008, reason: 'unauthorized' });

    const malformed = await openClient();
    malformed.send('{');
    expect(await nextClose(malformed)).toStrictEqual({ code: 1003, reason: 'invalid_json' });
  });

  it('closes with 1009 for an oversized frame and sends no hello', async () => {
    await makeServer();
    const socket = await openClient();
    let sawHello = false;
    socket.addEventListener('message', () => {
      sawHello = true;
    });
    socket.send(Buffer.alloc(4097));
    const closed = await nextClose(socket, 4000);
    expect(closed.code).toBe(1009);
    expect(sawHello).toBe(false);
  });

  it('closes with 1008 auth_timeout after five seconds', async () => {
    await makeServer();
    const socket = await openClient();
    const closed = await nextClose(socket, 7000);
    expect(closed).toStrictEqual({ code: 1008, reason: 'auth_timeout' });
  }, 10_000);

  it('answers a legal pull with a new snapshot and rejects unknown messages', async () => {
    await makeServer();
    const socket = await openClient();
    const messages = collectMessages(socket);
    socket.send(AUTH);
    await messages.next();
    await messages.next();

    socket.send(JSON.stringify({ type: 'pull' }));
    expect((await messages.next()) as Record<string, unknown>).toMatchObject({
      type: 'snapshot',
    });

    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: 'delete' }));
    expect(await closed).toStrictEqual({ code: 1003, reason: 'unknown_message' });
  });

  it('sends shutting_down and closes 1001 during drain', async () => {
    const server = await makeServer();
    const socket = await openClient();
    const messages = collectMessages(socket);
    socket.send(AUTH);
    await messages.next();
    await messages.next();
    const closePromise = nextClose(socket);
    await server.beginDrain();
    expect(await messages.next()).toStrictEqual({
      type: 'shutting_down',
      reason: 'daemon_stop',
    });
    expect(await closePromise).toStrictEqual({ code: 1001, reason: 'daemon_stop' });
    await server.close();
  });
});

describe('WebSocket auth and snapshot edges', () => {
  it('closes all malformed first frames with 1008', async () => {
    await makeServer();
    const cases: readonly [string, number, string][] = [
      ['{}', 1008, 'invalid_auth'],
      ['[]', 1008, 'invalid_auth'],
      [JSON.stringify({ type: 'auth' }), 1008, 'unauthorized'],
      [JSON.stringify({ type: 'auth', token: '' }), 1008, 'unauthorized'],
      [JSON.stringify({ type: 'pull' }), 1008, 'unauthorized'],
      [JSON.stringify({ type: 'hello' }), 1008, 'invalid_auth'],
      [JSON.stringify({ type: 'auth', token: TOKEN, extra: true }), 1008, 'invalid_auth'],
    ];
    for (const [payload, code, reason] of cases) {
      const socket = await openClient();
      const closed = nextClose(socket);
      socket.send(payload);
      expect(await closed, payload).toStrictEqual({ code, reason });
    }
  });

  it('does not echo the token and does not push periodically', async () => {
    await makeServer();
    const socket = await openClient();
    const messages = await authenticate(socket);
    await expect(messages.next(300)).rejects.toThrow('message timeout');
    socket.send(JSON.stringify({ type: 'pull' }));
    const snapshot = await messages.next();
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
    expect(JSON.stringify(snapshot)).not.toContain('authorization');
  });

  it('requires a fresh auth after reconnect', async () => {
    await makeServer();
    const first = await openClient();
    await authenticate(first);
    await closeClient(first);

    const second = await openClient();
    await authenticate(second);
  });

  it('accepts exactly 4096 bytes and rejects 4097 at transport level', async () => {
    await makeServer();
    const atLimit = await openClient();
    await authenticate(atLimit);
    const atLimitClosed = nextClose(atLimit);
    atLimit.send('x'.repeat(4096));
    expect((await atLimitClosed).code).toBe(1003);

    const overLimit = await openClient();
    await authenticate(overLimit);
    const overLimitClosed = nextClose(overLimit);
    overLimit.send('x'.repeat(4097));
    const closed = await overLimitClosed;
    expect(closed.code).toBe(1009);
    expect(closed.reason).not.toBe('frame_too_large');
  });

  it('coalesces a burst of pulls to one dirty follow-up snapshot', async () => {
    await makeServer();
    const socket = await openClient();
    const messages = await authenticate(socket);
    for (let index = 0; index < 100; index += 1) {
      socket.send(JSON.stringify({ type: 'pull' }));
    }

    let extra = 0;
    for (;;) {
      try {
        await messages.next(300);
        extra += 1;
        if (extra > 8) {
          break;
        }
      } catch {
        break;
      }
    }
    expect(extra).toBeLessThanOrEqual(3);
    socket.send(JSON.stringify({ type: 'pull' }));
    expect(await messages.next()).toMatchObject({ type: 'snapshot' });
  });

  it('keeps normal HTTP /v1/ws authenticated and non-websocket', async () => {
    await makeServer();
    const result = await new Promise<number>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port: 18700,
        method: 'GET',
        path: '/v1/ws',
        headers: { Host: HOST, Authorization: `Bearer ${TOKEN}` },
      });
      req.once('response', (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      req.once('error', reject);
      req.end();
    });
    expect(result).toBe(404);
  });

  it('applies the global token bucket to upgrades', async () => {
    await makeServer();
    for (let index = 0; index < 20; index += 1) {
      const response = await fetch('http://127.0.0.1:18700/v1/health/live');
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(
      (
        await rawUpgrade('/v1/ws', {
          'Sec-WebSocket-Protocol': WS_SUBPROTOCOL,
        })
      ).statusCode,
    ).toBe(429);
  });

  it('releases an unauthenticated slot after a failed auth', async () => {
    await makeServer();
    const held: Socket[] = [];
    for (let index = 0; index < 15; index += 1) {
      held.push(
        await rawUpgradeHold('/v1/ws', {
          'Sec-WebSocket-Protocol': WS_SUBPROTOCOL,
        }),
      );
    }
    const failed = await openClient();
    const failedClosed = nextClose(failed);
    failed.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    expect(await failedClosed).toStrictEqual({ code: 1008, reason: 'unauthorized' });

    held.push(
      await rawUpgradeHold('/v1/ws', {
        'Sec-WebSocket-Protocol': WS_SUBPROTOCOL,
      }),
    );
    expect(
      (
        await rawUpgrade('/v1/ws', {
          'Sec-WebSocket-Protocol': WS_SUBPROTOCOL,
        })
      ).statusCode,
    ).toBe(503);
    for (const socket of held) {
      socket.destroy();
    }
  }, 20_000);

  it('rejects the 17th unauthenticated connection with HTTP 503', async () => {
    await makeServer();
    const held: Socket[] = [];
    for (let index = 0; index < 16; index += 1) {
      held.push(
        await rawUpgradeHold('/v1/ws', {
          'Sec-WebSocket-Protocol': WS_SUBPROTOCOL,
        }),
      );
    }
    expect(
      (
        await rawUpgrade('/v1/ws', {
          'Sec-WebSocket-Protocol': WS_SUBPROTOCOL,
        })
      ).statusCode,
    ).toBe(503);

    held.pop()?.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const replacement = await rawUpgradeHold('/v1/ws', {
      'Sec-WebSocket-Protocol': WS_SUBPROTOCOL,
    });
    replacement.destroy();
    for (const socket of held) {
      socket.destroy();
    }
  }, 20_000);

  it('rejects the 33rd authenticated conversion with 1013 server_busy', async () => {
    let tick = 0;
    await makeServer(() => {
      tick += 1000;
      return tick;
    });
    const sockets: WebSocket[] = [];
    for (let index = 0; index < 32; index += 1) {
      const socket = await openClient();
      const messages = collectMessages(socket);
      socket.send(AUTH);
      await messages.next();
      await messages.next();
      sockets.push(socket);
    }

    const extra = await openClient();
    const closed = nextClose(extra);
    extra.send(AUTH);
    expect(await closed).toStrictEqual({ code: 1013, reason: 'server_busy' });

    await closeClient(sockets.pop() as WebSocket);
    const replacement = await openClient();
    await authenticate(replacement);
  }, 30_000);
});

describe('WebSocket outbound bounds', () => {
  it('enforces independent 64-message and 1 MiB queue limits', () => {
    expect(exceedsOutboundQueue(63, 0, 1)).toBe(false);
    expect(exceedsOutboundQueue(64, 0, 1)).toBe(true);
    expect(exceedsOutboundQueue(0, 1024 * 1024, 0)).toBe(false);
    expect(exceedsOutboundQueue(0, 1024 * 1024, 1)).toBe(true);
  });

  it('closes a snapshot that exceeds the 1 MiB queue limit as slow_client', async () => {
    const huge = makeApi();
    let calls = 0;
    const hugeApi: DaemonApi = {
      ...huge,
      getStatus: () => {
        calls += 1;
        return calls === 1
          ? ({ ...status, padding: 'x'.repeat(1024 * 1024) } as unknown as StatusView)
          : status;
      },
    };
    await makeServer(undefined, hugeApi);
    const slow = await openClient();
    const slowClosed = nextClose(slow);
    slow.send(AUTH);
    expect(await slowClosed).toStrictEqual({ code: 1013, reason: 'slow_client' });

    const healthy = await openClient();
    await authenticate(healthy);
  });
});

describe('WebSocket drain boundaries', () => {
  it('rejects new upgrades and closes unauthenticated clients during drain', async () => {
    const server = await makeServer();
    const socket = await openClient();
    const closed = nextClose(socket);
    await server.beginDrain();
    expect(await closed).toStrictEqual({ code: 1001, reason: 'daemon_stop' });
    expect(
      (
        await rawUpgrade('/v1/ws', {
          'Sec-WebSocket-Protocol': WS_SUBPROTOCOL,
        })
      ).statusCode,
    ).toBe(503);
  });

  it('does not wait for a client close handshake when the API closes', async () => {
    const server = await makeServer();
    const socket = await openClient();
    await authenticate(socket);
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(1000);
    await closeClient(socket);
  });
});
