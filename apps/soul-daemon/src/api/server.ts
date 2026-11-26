/**
 * Local management HTTP server.
 *
 * The server receives only the narrow DaemonApi facade and the token verifier.
 * It never receives a Store, a Repository collection, or a Runtime handle.
 * Fastify request logging is disabled: request bodies, headers and tokens are
 * not part of the operational log stream.
 */

import type { IncomingMessage } from 'node:http';

import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';

import { DaemonError } from '../errors.js';
import { ApiError, apiErrorEnvelope } from './errors.js';
import type { DaemonApi } from './daemon-api.js';
import type { ApiTokenVerifier } from './token.js';
import type { Readiness } from './wire.js';
import { API_BODY_LIMIT_BYTES, API_HOST, API_PORT } from './wire.js';
import { assertBearer } from './http/auth.js';
import { sendHttpError } from './http/errors.js';
import { applyCors, assertHost, assertOrigin } from './http/host-origin.js';
import { TokenBucket } from './http/limits.js';
import { WebSocketHub } from './ws.js';
import { hasSubprotocol, WS_MAX_FRAME_BYTES, WS_SUBPROTOCOL } from './ws-protocol.js';
import { registerEventReadRoutes } from './routes/events-read.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPersonaReadRoutes } from './routes/personas-read.js';
import { registerPersonaWriteRoutes } from './routes/personas-write.js';
import { registerSessionReadRoutes } from './routes/sessions-read.js';
import { registerStatusRoute } from './routes/status.js';
import { registerTaskReadRoutes } from './routes/tasks-read.js';

export type LocalApiState = 'assembled' | 'running' | 'draining' | 'stopped' | 'failed';

export interface LocalApiServer {
  readonly state: LocalApiState;
  readonly listening: boolean;
  /** Exposed for fastify.inject unit tests; Daemon does not use it. */
  readonly app: FastifyInstance;
  listen(): Promise<void>;
  beginDrain(): Promise<void>;
  close(): Promise<void>;
}

export interface LocalApiServerOptions {
  readonly api: DaemonApi;
  readonly token: ApiTokenVerifier;
  readonly readiness: () => Readiness;
  /** Tests may use 0; production omits this and gets API_PORT. */
  readonly port?: number;
  /** Fake monotonic clock for token-bucket tests. */
  readonly clock?: () => number;
}

interface ServerRuntime {
  readonly app: FastifyInstance;
  readonly hub: WebSocketHub;
}

function createApp(options: LocalApiServerOptions, getState: () => LocalApiState): ServerRuntime {
  // `logger: false` keeps Fastify from serializing request bodies or headers.
  const app = Fastify({
    logger: false,
    bodyLimit: API_BODY_LIMIT_BYTES,
    connectionTimeout: 30_000,
    keepAliveTimeout: 5_000,
    maxRequestsPerSocket: 1_000,
    trustProxy: false,
  });

  const bucket = new TokenBucket({
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const hub = new WebSocketHub({ api: options.api, token: options.token });

  app.register(websocket, {
    options: {
      maxPayload: WS_MAX_FRAME_BYTES,
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false,
      verifyClient: (
        info: { readonly req: IncomingMessage; readonly origin?: string },
        next: (
          accepted: boolean,
          code?: number,
          message?: string,
          headers?: Record<string, string>,
        ) => void,
      ): void => {
        const reject = (code: number, error: ApiError): void => {
          next(false, code, JSON.stringify(apiErrorEnvelope(error)), {
            'Content-Type': 'application/json',
          });
        };
        try {
          assertHost(info.req.headers.host);
          assertOrigin(info.req.headers.origin);
        } catch {
          reject(403, new ApiError('forbidden'));
          return;
        }
        if (!bucket.take()) {
          reject(429, new ApiError('rate_limited'));
          return;
        }
        if (info.req.url?.includes('?')) {
          reject(400, new ApiError('invalid_request'));
          return;
        }
        if (!hasSubprotocol(info.req.headers['sec-websocket-protocol'])) {
          reject(426, new ApiError('invalid_request'));
          return;
        }
        if (!hub.reserve(info.req)) {
          reject(503, new ApiError('unavailable'));
          return;
        }
        next(true);
      },
    },
  });
  app.after(() => {
    hub.register(app);
  });

  app.addHook('onRequest', async (request, reply) => {
    // Upgrade validation and reservation happen in the websocket transport's
    // verifyClient hook, before handleUpgrade. A normal HTTP GET to this path
    // still falls through to the management Bearer check.
    if (hub.isUpgrade(request)) {
      return;
    }

    assertHost(request.headers.host);
    const origin = assertOrigin(request.headers.origin);
    applyCors(reply, origin);

    if (!bucket.take()) {
      throw new ApiError('rate_limited');
    }

    if (request.method === 'OPTIONS') {
      return;
    }

    const path = request.url.split('?', 1)[0] ?? '';
    const management = path.startsWith('/v1/') && !path.startsWith('/v1/health/');
    if (management) {
      if (getState() === 'draining') {
        throw new ApiError('unavailable');
      }
      assertBearer(request.headers.authorization, options.token);
    }
  });

  app.addHook('onResponse', async (request) => {
    hub.releasePending(request.raw);
  });

  app.setErrorHandler((error, request, reply) => sendHttpError(error, request, reply));

  // Fastify's default 404 object would leak framework text; the method-not-
  // allowed path is normalized to the same fixed not_found envelope.
  app.setNotFoundHandler((_request, reply) => {
    const error = new ApiError('not_found');
    return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  });

  app.options('/*', async (_request, reply) => reply.code(204).send());

  registerHealthRoutes(app, {
    readiness: options.readiness,
    isDraining: () => getState() === 'draining',
  });
  registerStatusRoute(app, options.api);
  registerPersonaReadRoutes(app, options.api);
  registerPersonaWriteRoutes(app, options.api);
  registerEventReadRoutes(app, options.api);
  registerTaskReadRoutes(app, options.api);
  registerSessionReadRoutes(app, options.api);

  return { app, hub };
}

export function createLocalApiServer(options: LocalApiServerOptions): LocalApiServer {
  let state: LocalApiState = 'assembled';
  const runtime = createApp(options, () => state);
  const port = options.port ?? API_PORT;
  let started = false;
  let closed = false;

  return Object.freeze({
    get state(): LocalApiState {
      return state;
    },

    app: runtime.app,

    get listening(): boolean {
      return state === 'running' || state === 'draining';
    },

    async listen(): Promise<void> {
      if (started) {
        return;
      }
      try {
        await runtime.app.listen({ host: API_HOST, port });
        started = true;
        state = 'running';
      } catch (error) {
        state = 'failed';
        throw new DaemonError('http_api_start_failed', 'local API failed to listen', {
          cause: error,
        });
      }
    },

    async beginDrain(): Promise<void> {
      if (state === 'running' || state === 'assembled') {
        state = 'draining';
        await runtime.hub.beginDrain();
        return;
      }
      if (state === 'draining') {
        return;
      }
      throw new DaemonError('shutdown_failed', 'local API is not in a drainable state');
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      try {
        await runtime.hub.close();
        await runtime.app.close();
        closed = true;
        state = 'stopped';
      } catch (error) {
        state = 'failed';
        throw new DaemonError('shutdown_failed', 'local API failed to close', {
          cause: error,
        });
      }
    },
  });
}
