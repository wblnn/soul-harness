/** Local `soul.ws.v1` protocol types and bounded message parsing. */

export const WS_SUBPROTOCOL = 'soul.ws.v1';
export const WS_MAX_FRAME_BYTES = 4096;

export const WS_CLOSE = {
  authTimeout: 1008,
  unauthorized: 1008,
  invalidAuth: 1008,
  frameTooLarge: 1009,
  invalidJson: 1003,
  unknownMessage: 1003,
  serverBusy: 1013,
  slowClient: 1013,
  daemonStop: 1001,
} as const;

export type WsCloseCode = (typeof WS_CLOSE)[keyof typeof WS_CLOSE];

export interface WsCloseError {
  readonly code: WsCloseCode;
  readonly reason: string;
}

export class WsProtocolError extends Error implements WsCloseError {
  readonly code: WsCloseCode;
  readonly reason: string;

  constructor(code: WsCloseCode, reason: string) {
    super(reason);
    this.name = 'WsProtocolError';
    this.code = code;
    this.reason = reason;
  }
}

function bytesOf(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
    return Buffer.concat(data as Buffer[]);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return Buffer.alloc(0);
}

function textOf(data: unknown): string {
  const bytes = bytesOf(data);
  if (bytes.length > WS_MAX_FRAME_BYTES) {
    throw new WsProtocolError(WS_CLOSE.frameTooLarge, 'frame_too_large');
  }
  return bytes.toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WsProtocolError(WS_CLOSE.invalidJson, 'invalid_json');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ParsedAuth {
  readonly token: string;
}

/**
 * Strict pre-auth parser. Missing token is an auth failure; malformed JSON is
 * a different close code so transport/protocol failures remain observable.
 */
export function parseAuthFrame(data: unknown): ParsedAuth {
  const value = parseJson(textOf(data));
  if (!isRecord(value)) {
    throw new WsProtocolError(WS_CLOSE.invalidAuth, 'invalid_auth');
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && value['type'] === 'pull') {
    throw new WsProtocolError(WS_CLOSE.unauthorized, 'unauthorized');
  }
  if (keys.length === 1 && value['type'] === 'auth') {
    throw new WsProtocolError(WS_CLOSE.unauthorized, 'unauthorized');
  }
  if (keys.length !== 2 || value['type'] !== 'auth') {
    throw new WsProtocolError(WS_CLOSE.invalidAuth, 'invalid_auth');
  }
  if (typeof value['token'] !== 'string' || value['token'].length === 0) {
    throw new WsProtocolError(WS_CLOSE.unauthorized, 'unauthorized');
  }
  return { token: value['token'] };
}

/** Post-auth parser: only the exact one-field pull message is valid. */
export function parsePullFrame(data: unknown): 'pull' {
  const value = parseJson(textOf(data));
  if (!isRecord(value) || Object.keys(value).length !== 1 || value['type'] !== 'pull') {
    throw new WsProtocolError(WS_CLOSE.unknownMessage, 'unknown_message');
  }
  return 'pull';
}

export function hasSubprotocol(header: unknown): boolean {
  if (typeof header !== 'string') {
    return false;
  }
  return header
    .split(',')
    .map((part) => part.trim())
    .includes(WS_SUBPROTOCOL);
}

export interface ServerHello {
  readonly type: 'hello';
  readonly protocol: typeof WS_SUBPROTOCOL;
  readonly serverTime: number;
}

export interface ServerSnapshot {
  readonly type: 'snapshot';
  readonly status: unknown;
}

export interface ServerShuttingDown {
  readonly type: 'shutting_down';
  readonly reason: 'daemon_stop';
}

export function helloMessage(serverTime: number): ServerHello {
  return { type: 'hello', protocol: WS_SUBPROTOCOL, serverTime };
}

export function snapshotMessage(status: unknown): ServerSnapshot {
  return { type: 'snapshot', status };
}

export function shuttingDownMessage(): ServerShuttingDown {
  return { type: 'shutting_down', reason: 'daemon_stop' };
}
