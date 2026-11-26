/**
 * Local `soul.ws.v1` transport.
 *
 * This module owns connection slots, first-message authentication, bounded
 * outbound queues, pull coalescing and drain/close. It receives only the
 * narrow DaemonApi facade and the token verifier; no Store, Repository or
 * Runtime handle is reachable here.
 */

import type { IncomingMessage } from 'node:http';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket as WsSocket } from '@fastify/websocket';

import type { DaemonApi } from './daemon-api.js';
import type { ApiTokenVerifier } from './token.js';
import {
  WS_CLOSE,
  WsProtocolError,
  helloMessage,
  parseAuthFrame,
  parsePullFrame,
  shuttingDownMessage,
  snapshotMessage,
} from './ws-protocol.js';

const MAX_UNAUTHENTICATED = 16;
const MAX_AUTHENTICATED = 32;
const AUTH_TIMEOUT_MS = 5_000;
const MAX_QUEUE_MESSAGES = 64;
const MAX_QUEUE_BYTES = 1024 * 1024;

/** Pure queue bound used by the connection and its unit test. */
export function exceedsOutboundQueue(
  messageCount: number,
  queuedBytes: number,
  nextBytes: number,
): boolean {
  return messageCount >= MAX_QUEUE_MESSAGES || queuedBytes + nextBytes > MAX_QUEUE_BYTES;
}

export interface WebSocketHubOptions {
  readonly api: DaemonApi;
  readonly token: ApiTokenVerifier;
  readonly clock?: () => number;
}

interface Slot {
  released: boolean;
  authenticated: boolean;
}

interface QueueItem {
  readonly payload: string;
  readonly bytes: number;
  readonly onSent?: () => void;
}

function isUpgrade(request: FastifyRequest): boolean {
  const upgrade = request.headers.upgrade;
  const connection = request.headers.connection;
  if (typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket') {
    return false;
  }
  if (
    typeof connection !== 'string' ||
    !connection
      .toLowerCase()
      .split(',')
      .map((part) => part.trim())
      .includes('upgrade')
  ) {
    return false;
  }
  return request.url.split('?', 1)[0] === '/v1/ws';
}

class ClientConnection {
  readonly #socket: WsSocket;
  readonly #hub: WebSocketHub;
  readonly #slot: Slot;

  #closed = false;
  #authenticated = false;
  #authTimer: ReturnType<typeof setTimeout> | null = null;
  #queue: QueueItem[] = [];
  #queueBytes = 0;
  #inFlightBytes = 0;
  #sending = false;
  #pullInFlight = false;
  #pullDirty = false;

  constructor(socket: WsSocket, hub: WebSocketHub, slot: Slot, authTimeoutMs: number) {
    this.#socket = socket;
    this.#hub = hub;
    this.#slot = slot;

    socket.on('message', (data: unknown) => this.#onMessage(data));
    socket.on('close', () => this.#onClose());
    socket.on('error', () => this.#onTransportError());

    this.#authTimer = setTimeout(() => {
      this.#close(WS_CLOSE.authTimeout, 'auth_timeout');
    }, authTimeoutMs);
    this.#authTimer.unref?.();
  }

  #onMessage(data: unknown): void {
    if (this.#closed) {
      return;
    }

    if (!this.#authenticated) {
      let parsed;
      try {
        parsed = parseAuthFrame(data);
      } catch (error) {
        if (error instanceof WsProtocolError) {
          this.#close(error.code, error.reason);
        } else {
          this.#close(WS_CLOSE.invalidAuth, 'invalid_auth');
        }
        return;
      }
      if (!this.#hub.verifyToken(parsed.token)) {
        this.#close(WS_CLOSE.unauthorized, 'unauthorized');
        return;
      }
      if (!this.#hub.authenticate(this.#slot)) {
        this.#close(WS_CLOSE.serverBusy, 'server_busy');
        return;
      }
      this.#authenticated = true;
      if (this.#authTimer !== null) {
        clearTimeout(this.#authTimer);
        this.#authTimer = null;
      }
      this.#enqueue(helloMessage(this.#hub.now()));
      this.#sendSnapshot();
      return;
    }

    try {
      parsePullFrame(data);
    } catch (error) {
      if (error instanceof WsProtocolError) {
        this.#close(error.code, error.reason);
      } else {
        this.#close(WS_CLOSE.unknownMessage, 'unknown_message');
      }
      return;
    }

    if (this.#pullInFlight) {
      this.#pullDirty = true;
      return;
    }
    this.#sendSnapshot();
  }

  #sendSnapshot(): void {
    if (this.#closed || !this.#authenticated || this.#pullInFlight) {
      return;
    }
    this.#pullInFlight = true;
    let status: unknown;
    try {
      status = this.#hub.getStatus();
    } catch {
      this.#close(WS_CLOSE.slowClient, 'slow_client');
      return;
    }
    const sent = this.#enqueue(snapshotMessage(status), () => {
      this.#pullInFlight = false;
      if (this.#pullDirty) {
        this.#pullDirty = false;
        this.#sendSnapshot();
      }
    });
    if (!sent) {
      this.#pullInFlight = false;
    }
  }

  #enqueue(message: unknown, onSent?: () => void): boolean {
    if (this.#closed) {
      return false;
    }
    const payload = JSON.stringify(message);
    const bytes = Buffer.byteLength(payload, 'utf8');
    const queuedCount = this.#queue.length + (this.#sending ? 1 : 0);
    if (exceedsOutboundQueue(queuedCount, this.#queueBytes + this.#inFlightBytes, bytes)) {
      this.#close(WS_CLOSE.slowClient, 'slow_client');
      return false;
    }
    this.#queue.push({ payload, bytes, ...(onSent === undefined ? {} : { onSent }) });
    this.#queueBytes += bytes;
    this.#drain();
    return true;
  }

  #drain(): void {
    if (this.#closed || this.#sending) {
      return;
    }
    const item = this.#queue.shift();
    if (item === undefined) {
      return;
    }
    this.#queueBytes -= item.bytes;
    this.#inFlightBytes = item.bytes;
    if (this.#socket.readyState !== 1) {
      this.#terminate();
      return;
    }
    this.#sending = true;
    try {
      this.#socket.send(item.payload, (error?: Error) => {
        this.#sending = false;
        this.#inFlightBytes = 0;
        if (this.#closed) {
          return;
        }
        if (error != null) {
          this.#terminate();
          return;
        }
        item.onSent?.();
        this.#drain();
      });
    } catch {
      this.#sending = false;
      this.#inFlightBytes = 0;
      this.#terminate();
    }
  }

  #close(code: number, reason: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#clearLocalState();
    this.#hub.release(this.#slot);
    try {
      this.#socket.close(code, reason);
    } catch {
      try {
        this.#socket.terminate();
      } catch {
        // Already gone.
      }
    }
  }

  #onClose(): void {
    this.#closed = true;
    this.#clearLocalState();
    this.#hub.release(this.#slot);
    this.#hub.remove(this);
  }

  #onTransportError(): void {
    this.#closed = true;
    this.#clearLocalState();
    this.#hub.release(this.#slot);
    this.#hub.remove(this);
    try {
      this.#socket.terminate();
    } catch {
      // Already gone.
    }
  }

  #clearLocalState(): void {
    if (this.#authTimer !== null) {
      clearTimeout(this.#authTimer);
      this.#authTimer = null;
    }
    this.#queue = [];
    this.#queueBytes = 0;
    this.#inFlightBytes = 0;
    this.#sending = false;
    this.#pullInFlight = false;
    this.#pullDirty = false;
  }

  #terminate(): void {
    this.#closed = true;
    this.#clearLocalState();
    this.#hub.release(this.#slot);
    this.#hub.remove(this);
    try {
      this.#socket.terminate();
    } catch {
      // Already gone.
    }
  }

  shutdown(): void {
    if (this.#closed) {
      return;
    }
    this.#clearLocalState();
    this.#hub.release(this.#slot);
    try {
      if (this.#authenticated && this.#socket.readyState === 1) {
        this.#socket.send(JSON.stringify(shuttingDownMessage()));
      }
      this.#socket.close(WS_CLOSE.daemonStop, 'daemon_stop');
    } catch {
      try {
        this.#socket.terminate();
      } catch {
        // Already gone.
      }
    }
    this.#closed = true;
  }

  terminate(): void {
    this.#terminate();
  }
}

export class WebSocketHub {
  readonly #api: DaemonApi;
  readonly #token: ApiTokenVerifier;
  readonly #clock: () => number;
  readonly #authTimeoutMs: number;
  readonly #connections = new Set<ClientConnection>();
  readonly #unauthSlots = new Set<Slot>();
  readonly #authSlots = new Set<Slot>();
  readonly #pending = new Map<IncomingMessage, Slot>();
  #draining = false;
  #closed = false;

  constructor(options: WebSocketHubOptions) {
    this.#api = options.api;
    this.#token = options.token;
    this.#clock = options.clock ?? ((): number => Date.now());
    this.#authTimeoutMs = AUTH_TIMEOUT_MS;
  }

  get isDraining(): boolean {
    return this.#draining;
  }

  now(): number {
    return this.#clock();
  }

  verifyToken(token: string): boolean {
    return this.#token.verify(token);
  }

  getStatus(): unknown {
    return this.#api.getStatus();
  }

  isUpgrade(request: FastifyRequest): boolean {
    return isUpgrade(request);
  }

  reserve(request: IncomingMessage): boolean {
    if (this.#draining || this.#closed || this.#unauthSlots.size >= MAX_UNAUTHENTICATED) {
      return false;
    }
    const slot: Slot = { released: false, authenticated: false };
    this.#unauthSlots.add(slot);
    this.#pending.set(request, slot);
    const release = (): void => {
      this.releasePending(request);
    };
    request.once('close', release);
    request.once('error', release);
    return true;
  }

  releasePending(request: IncomingMessage): void {
    const slot = this.#pending.get(request);
    if (slot === undefined) {
      return;
    }
    this.#pending.delete(request);
    this.release(slot);
  }

  claim(request: IncomingMessage): Slot | null {
    const slot = this.#pending.get(request);
    if (slot === undefined) {
      return null;
    }
    this.#pending.delete(request);
    if (slot.released) {
      return null;
    }
    return slot;
  }

  authenticate(slot: Slot): boolean {
    if (slot.released || this.#closed || this.#draining) {
      return false;
    }
    if (this.#authSlots.size >= MAX_AUTHENTICATED) {
      this.release(slot);
      return false;
    }
    this.#unauthSlots.delete(slot);
    this.#authSlots.add(slot);
    slot.authenticated = true;
    return true;
  }

  release(slot: Slot): void {
    if (slot.released) {
      return;
    }
    slot.released = true;
    this.#unauthSlots.delete(slot);
    this.#authSlots.delete(slot);
    for (const [request, pending] of this.#pending) {
      if (pending === slot) {
        this.#pending.delete(request);
        break;
      }
    }
  }

  register(app: FastifyInstance): void {
    app.get('/v1/ws', { websocket: true }, (socket, request) => {
      const slot = this.claim(request.raw);
      if (slot === null) {
        socket.close(WS_CLOSE.serverBusy, 'server_busy');
        return;
      }
      if (this.#draining || this.#closed) {
        this.release(slot);
        socket.close(WS_CLOSE.daemonStop, 'daemon_stop');
        return;
      }
      const connection = new ClientConnection(socket, this, slot, this.#authTimeoutMs);
      this.#connections.add(connection);
    });
  }

  remove(connection: ClientConnection): void {
    this.#connections.delete(connection);
  }

  async beginDrain(): Promise<void> {
    if (this.#draining) {
      return;
    }
    this.#draining = true;
    for (const request of [...this.#pending.keys()]) {
      this.releasePending(request);
      try {
        request.destroy();
      } catch {
        // Best effort.
      }
    }
    for (const connection of [...this.#connections]) {
      connection.shutdown();
    }
    for (const slot of [...this.#unauthSlots, ...this.#authSlots]) {
      this.release(slot);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#draining = true;
    for (const request of [...this.#pending.keys()]) {
      this.releasePending(request);
      try {
        request.destroy();
      } catch {
        // Best effort.
      }
    }
    for (const connection of [...this.#connections]) {
      connection.terminate();
    }
    this.#connections.clear();
  }
}
