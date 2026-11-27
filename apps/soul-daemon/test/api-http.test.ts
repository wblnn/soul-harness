import { afterEach, describe, expect, it } from 'vitest';

import type { DaemonApi, StatusView } from '../src/api/daemon-api.js';
import { createLocalApiServer, type LocalApiServer } from '../src/api/server.js';
import type { ApiTokenVerifier } from '../src/api/token.js';
import type { Readiness, SessionView } from '../src/api/wire.js';

const TOKEN = 'a'.repeat(43);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const HOST = { host: '127.0.0.1:18700' };

const persona = {
  id: 'psn_01J00000000000000000000000',
  displayName: 'Alice',
  state: 'RUNNING',
  version: 3,
  createdAt: 1,
  updatedAt: 2,
} as const;

const event = {
  id: 'evt_01J00000000000000000000000',
  status: 'received',
  statusReason: null,
  receivedAt: 10,
  occurredAt: null,
  archiveState: 'none',
} as const;

const task = {
  id: 'tsk_01J00000000000000000000000',
  state: 'queued',
  kind: 'internal',
  channel: 'inner',
  priority: 1,
  attempt: 0,
  scheduledAt: null,
  startedAt: null,
  finishedAt: null,
} as const;

const session = {
  id: 'ses_01J00000000000000000000000',
  adapterId: 'adapter-1',
  openedAt: 10,
  closedAt: null,
} as unknown as SessionView;

const status: StatusView = {
  phase: 'RUNNING',
  pid: 1234,
  startedAt: '2026-01-01T00:00:00.000Z',
  bootId: 'boot-id',
  storeOpen: true,
  lockHeld: true,
  personaLifecycleAssembled: true,
  recovery: null,
  scheduler: null,
  components: {
    personaLifecycle: { assembled: true, autoStarted: false },
    eventBus: { assembled: true, initialized: true, transport: 'none', acceptsInput: false },
    scheduler: {
      assembled: true,
      started: true,
      state: 'running',
      handlerKinds: 0,
      dispatchesTasks: false,
    },
    httpApi: 'running',
    healthEndpoint: 'running',
  },
  capabilities: {
    persistence: true,
    migrations: true,
    instanceLock: true,
    structuredLogging: true,
    personaLifecycle: 'assembled',
    runtimeRecovery: 'assembled',
    eventBus: 'assembled_no_transport',
    eventIngress: 'unavailable_no_transport',
    scheduler: 'running',
    taskDispatch: 'unavailable_no_handlers',
    httpApi: 'available',
    healthEndpoint: 'available',
  },
};

const verifier: ApiTokenVerifier = {
  verify: (candidate) => candidate === TOKEN,
};

function makeApi(overrides: Partial<DaemonApi> = {}): DaemonApi {
  return {
    getStatus: () => status,
    getReadiness: (): Readiness => ({ ready: true, reason: null }),
    listPersonas: () => [persona],
    getPersona: (id) => (id === persona.id ? persona : null),
    createPersona: async () => persona,
    startPersona: async () => persona,
    suspendPersona: async () => persona,
    resumePersona: async () => persona,
    stopPersona: async () => persona,
    listEvents: () => [event],
    getEvent: ({ personaId, eventId }) =>
      personaId === persona.id && eventId === event.id ? event : null,
    listTasks: () => [task],
    listSessions: () => [session],
    ...overrides,
  };
}

const servers: LocalApiServer[] = [];

function makeServer(
  options: {
    api?: DaemonApi;
    readiness?: () => Readiness;
    clock?: () => number;
  } = {},
): LocalApiServer {
  const server = createLocalApiServer({
    api: options.api ?? makeApi(),
    token: verifier,
    readiness: options.readiness ?? (() => ({ ready: true, reason: null })),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  servers.push(server);
  return server;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { ...HOST, ...extra };
}

function body(response: { json: () => unknown }): Record<string, unknown> {
  return response.json() as Record<string, unknown>;
}

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

describe('HTTP health and auth', () => {
  it('serves anonymous minimal health without paths or scheduler statistics', async () => {
    const server = makeServer();
    const live = await server.app.inject({ method: 'GET', url: '/v1/health/live', headers: HOST });
    const ready = await server.app.inject({
      method: 'GET',
      url: '/v1/health/ready',
      headers: HOST,
    });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toStrictEqual({ status: 'ok' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toStrictEqual({ status: 'ready' });
    expect(live.body).not.toContain('dataDir');
    expect(live.body).not.toContain('scheduler');
  });

  it('returns only fixed readiness reasons', async () => {
    const server = makeServer({
      readiness: () => ({ ready: false, reason: 'store_unavailable' }),
    });
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/health/ready',
      headers: HOST,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toStrictEqual({
      status: 'not_ready',
      reason: 'store_unavailable',
    });
    expect(response.body).not.toContain('private');
  });

  it('rejects missing and wrong Bearer tokens and accepts the valid one', async () => {
    const server = makeServer();
    for (const authorization of [undefined, 'Bearer wrong', 'bearer ' + TOKEN, `Basic ${TOKEN}`]) {
      const response = await server.app.inject({
        method: 'GET',
        url: '/v1/status',
        headers: headers(authorization === undefined ? {} : { authorization }),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toStrictEqual({
        error: { code: 'unauthorized', message: 'authentication required' },
      });
    }

    const allowed = await server.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: headers(AUTH),
    });
    expect(allowed.statusCode).toBe(200);
    expect(body(allowed)).toStrictEqual(status);
  });

  it('applies auth to every management read route', async () => {
    const server = makeServer();
    const urls = [
      '/v1/status',
      '/v1/personas',
      `/v1/personas/${persona.id}`,
      `/v1/personas/${persona.id}/events`,
      `/v1/personas/${persona.id}/events/${event.id}`,
      `/v1/personas/${persona.id}/tasks`,
      `/v1/personas/${persona.id}/sessions`,
    ];
    for (const url of urls) {
      const response = await server.app.inject({ method: 'GET', url, headers: HOST });
      expect(response.statusCode, url).toBe(401);
    }
  });
});

describe('HTTP Host / Origin / CORS', () => {
  it('rejects non-exact Host values', async () => {
    const server = makeServer();
    for (const host of ['localhost:18700', 'evil.example', '127.0.0.1:18701', '']) {
      const response = await server.app.inject({
        method: 'GET',
        url: '/v1/health/live',
        headers: { host },
      });
      expect(response.statusCode, host).toBe(403);
    }
  });

  it('validates Host before returning a not-found envelope', async () => {
    const server = makeServer();
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/does-not-exist',
      headers: { host: 'evil.example' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('allows no Origin for CLI clients with a token', async () => {
    const server = makeServer();
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: headers(AUTH),
    });
    expect(response.statusCode).toBe(200);
  });

  it('returns exact CORS headers only for allowlisted Origins', async () => {
    const server = makeServer();
    const allowed = await server.app.inject({
      method: 'GET',
      url: '/v1/health/live',
      headers: headers({ origin: 'http://127.0.0.1:18701' }),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://127.0.0.1:18701');
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
    expect(allowed.headers['vary']).toBe('Origin');

    for (const origin of ['http://localhost:18701', 'https://evil.example', '*']) {
      const rejected = await server.app.inject({
        method: 'GET',
        url: '/v1/health/live',
        headers: headers({ origin }),
      });
      expect(rejected.statusCode, origin).toBe(403);
    }
  });

  it('handles allowed and rejected OPTIONS without requiring a token', async () => {
    const server = makeServer();
    const allowed = await server.app.inject({
      method: 'OPTIONS',
      url: '/v1/status',
      headers: headers({ origin: 'http://127.0.0.1:18701' }),
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://127.0.0.1:18701');
    expect(allowed.headers['access-control-allow-methods']).toContain('OPTIONS');
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();

    const rejected = await server.app.inject({
      method: 'OPTIONS',
      url: '/v1/status',
      headers: headers({ origin: 'http://evil.example' }),
    });
    expect(rejected.statusCode).toBe(403);
  });
});

describe('HTTP read routes and DTOs', () => {
  it('returns Persona views without internal fields', async () => {
    const server = makeServer();
    const list = await server.app.inject({
      method: 'GET',
      url: '/v1/personas',
      headers: headers(AUTH),
    });
    const one = await server.app.inject({
      method: 'GET',
      url: `/v1/personas/${persona.id}`,
      headers: headers(AUTH),
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toStrictEqual({ personas: [persona] });
    expect(one.json()).toStrictEqual({ persona });
    expect(list.body).not.toContain('bootId');
    expect(list.body).not.toContain('runtimeState');
  });

  it('returns event/task/session metadata without raw content', async () => {
    const server = makeServer();
    const events = await server.app.inject({
      method: 'GET',
      url: `/v1/personas/${persona.id}/events`,
      headers: headers(AUTH),
    });
    const eventOne = await server.app.inject({
      method: 'GET',
      url: `/v1/personas/${persona.id}/events/${event.id}`,
      headers: headers(AUTH),
    });
    const tasks = await server.app.inject({
      method: 'GET',
      url: `/v1/personas/${persona.id}/tasks`,
      headers: headers(AUTH),
    });
    const sessions = await server.app.inject({
      method: 'GET',
      url: `/v1/personas/${persona.id}/sessions`,
      headers: headers(AUTH),
    });

    for (const response of [events, eventOne, tasks, sessions]) {
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('summary');
      expect(response.body).not.toContain('archiveRef');
      expect(response.body).not.toContain('adapterEventRef');
      expect(response.body).not.toContain('sessionId');
      expect(response.body).not.toContain('payloadJson');
      expect(response.body).not.toContain('runId');
      expect(response.body).not.toContain('externalId');
      expect(response.body).not.toContain('metaJson');
    }
    expect(eventOne.json()).toStrictEqual({ event });
  });

  it('rejects malformed persona ids before any facade call', async () => {
    const calls = {
      getPersona: 0,
      listEvents: 0,
      getEvent: 0,
      listTasks: 0,
      listSessions: 0,
      startPersona: 0,
    };
    const server = makeServer({
      api: makeApi({
        getPersona: () => {
          calls.getPersona += 1;
          return null;
        },
        listEvents: () => {
          calls.listEvents += 1;
          return [];
        },
        getEvent: () => {
          calls.getEvent += 1;
          return null;
        },
        listTasks: () => {
          calls.listTasks += 1;
          return [];
        },
        listSessions: () => {
          calls.listSessions += 1;
          return [];
        },
        startPersona: async () => {
          calls.startPersona += 1;
          return persona;
        },
      }),
    });
    const malformed = 'psn_bad';
    const requests = [
      { method: 'GET', url: `/v1/personas/${malformed}` },
      { method: 'GET', url: `/v1/personas/${malformed}/events` },
      { method: 'GET', url: `/v1/personas/${malformed}/events/${event.id}` },
      { method: 'GET', url: `/v1/personas/${malformed}/tasks` },
      { method: 'GET', url: `/v1/personas/${malformed}/sessions` },
      { method: 'POST', url: `/v1/personas/${malformed}/start` },
    ];
    for (const request of requests) {
      const response = await server.app.inject({
        ...request,
        headers: headers(AUTH),
      });
      expect(response.statusCode, request.url).toBe(400);
      expect(response.json()).toStrictEqual({
        error: { code: 'invalid_request', message: 'invalid request' },
      });
    }
    expect(calls).toStrictEqual({
      getPersona: 0,
      listEvents: 0,
      getEvent: 0,
      listTasks: 0,
      listSessions: 0,
      startPersona: 0,
    });
  });

  it('keeps not-found semantics for a well-formed missing persona', async () => {
    const server = makeServer();
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/personas/psn_01J00000000000000000000001',
      headers: headers(AUTH),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toStrictEqual({
      error: { code: 'not_found', message: 'resource not found' },
    });
  });

  it('uses persona-scoped event lookup', async () => {
    const calls: Array<{ personaId: string; eventId: string }> = [];
    const server = makeServer({
      api: makeApi({
        getEvent: (input) => {
          calls.push({ personaId: input.personaId, eventId: input.eventId });
          return null;
        },
      }),
    });
    const response = await server.app.inject({
      method: 'GET',
      url: `/v1/personas/${persona.id}/events/${event.id}`,
      headers: headers(AUTH),
    });
    expect(response.statusCode).toBe(404);
    expect(calls).toStrictEqual([{ personaId: persona.id, eventId: event.id }]);
  });

  it('validates limits, enums, ids, unknown paths and methods with fixed envelopes', async () => {
    const server = makeServer();
    const cases: Array<{ url: string; code: number }> = [
      { url: '/v1/personas?limit=0', code: 400 },
      { url: '/v1/personas?limit=201', code: 400 },
      { url: '/v1/personas?limit=1.5', code: 400 },
      { url: '/v1/personas?state=lowercase', code: 400 },
      { url: '/v1/personas/%00', code: 400 },
      { url: '/v1/does-not-exist', code: 404 },
    ];
    for (const item of cases) {
      const response = await server.app.inject({
        method: 'GET',
        url: item.url,
        headers: headers(AUTH),
      });
      expect(response.statusCode, item.url).toBe(item.code);
      expect(body(response)['error']).toMatchObject({
        code: item.code === 404 ? 'not_found' : 'invalid_request',
      });
      expect(response.body).not.toContain('dataDir');
      expect(response.body).not.toContain('stack');
    }

    const wrongMethod = await server.app.inject({
      method: 'DELETE',
      url: '/v1/status',
      headers: headers(AUTH),
    });
    expect(wrongMethod.statusCode).toBe(404);
    expect(body(wrongMethod)['error']).toMatchObject({ code: 'not_found' });
  });
});

describe('HTTP limits and errors', () => {
  it('waits for in-flight HTTP work before close resolves', async () => {
    const server = makeServer();
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    server.app.get('/v1/test-slow', async () => {
      startedResolve?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      return { ok: true };
    });
    await server.listen();
    const address = server.app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('test server did not expose a TCP port');
    }

    const request = fetch(`http://127.0.0.1:${address.port}/v1/test-slow`, {
      headers: {
        host: '127.0.0.1:18700',
        authorization: `Bearer ${TOKEN}`,
      },
    });
    await started;
    const closing = server.close();
    const response = await request;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ ok: true });
    await closing;
  });

  it('does not report a rejected API close as successful or already closed', async () => {
    const server = makeServer();
    const closeable = server.app as unknown as { close: () => Promise<void> };
    const original = closeable.close;
    closeable.close = async () => {
      throw new Error('close failed');
    };

    await expect(server.close()).rejects.toMatchObject({ code: 'shutdown_failed' });
    expect(server.state).toBe('failed');

    closeable.close = original;
    await server.close();
    expect(server.state).toBe('stopped');
  });

  it('returns 503 while draining', async () => {
    const server = makeServer();
    await server.beginDrain();
    const management = await server.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: headers(AUTH),
    });
    const ready = await server.app.inject({
      method: 'GET',
      url: '/v1/health/ready',
      headers: HOST,
    });
    const live = await server.app.inject({
      method: 'GET',
      url: '/v1/health/live',
      headers: HOST,
    });
    expect(management.statusCode).toBe(503);
    expect(body(management)['error']).toMatchObject({ code: 'unavailable' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toStrictEqual({ status: 'not_ready', reason: 'draining' });
    expect(live.statusCode).toBe(200);
  });

  it('enforces the global token bucket with a fake clock across health and management', async () => {
    let now = 0;
    const server = makeServer({ clock: () => now });

    for (let index = 0; index < 20; index += 1) {
      const response = await server.app.inject({
        method: 'GET',
        url: '/v1/health/live',
        headers: HOST,
      });
      expect(response.statusCode, `burst ${index}`).toBe(200);
    }
    const limited = await server.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: headers(AUTH),
    });
    expect(limited.statusCode).toBe(429);
    expect(body(limited)['error']).toMatchObject({ code: 'rate_limited' });

    now += 500;
    const afterHalfSecond = await server.app.inject({
      method: 'GET',
      url: '/v1/health/live',
      headers: HOST,
    });
    expect(afterHalfSecond.statusCode).toBe(200);

    now += 1000;
    for (let index = 0; index < 2; index += 1) {
      const response = await server.app.inject({
        method: 'GET',
        url: '/v1/health/live',
        headers: HOST,
      });
      expect(response.statusCode, `refill ${index}`).toBe(200);
    }
    const limitedAgain = await server.app.inject({
      method: 'GET',
      url: '/v1/health/live',
      headers: HOST,
    });
    expect(limitedAgain.statusCode).toBe(429);
  });

  it('rejects an oversized JSON body with the fixed too_large envelope', async () => {
    const server = makeServer();
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/status',
      headers: headers({ ...AUTH, 'content-type': 'application/json' }),
      payload: JSON.stringify({ padding: 'x'.repeat(65 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toStrictEqual({
      error: { code: 'too_large', message: 'request body too large' },
    });
  });

  it('normalizes malformed JSON and unknown errors without leaking details', async () => {
    const server = makeServer({
      api: makeApi({
        getStatus: () => {
          throw new Error('private path C:\\secret\\file');
        },
      }),
    });
    const malformed = await server.app.inject({
      method: 'POST',
      url: '/v1/status',
      headers: headers({ ...AUTH, 'content-type': 'application/json' }),
      payload: '{"private":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toStrictEqual({
      error: { code: 'invalid_request', message: 'invalid request' },
    });

    const internal = await server.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: headers(AUTH),
    });
    expect(internal.statusCode).toBe(500);
    expect(internal.json()).toStrictEqual({
      error: { code: 'internal_error', message: 'internal error' },
    });
    expect(internal.body).not.toContain('private path');
    expect(internal.body).not.toContain('C:\\secret');
  });
});
