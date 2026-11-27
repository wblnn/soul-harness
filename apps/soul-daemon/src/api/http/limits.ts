/**
 * HTTP-only limits and query parsing. No Store or Repository import belongs
 * here: these helpers only turn untrusted request text into bounded values.
 */

import { isPersonaId, type PersonaId } from '@soul-harness/contracts';

import { API_DEFAULT_LIST_LIMIT, API_MAX_LIST_LIMIT } from '../wire.js';
import { ApiError } from '../errors.js';

export interface TokenBucketOptions {
  readonly capacity?: number;
  readonly refillPerSecond?: number;
  /** Monotonic clock. Tests inject a fake; production defaults to performance.now(). */
  readonly clock?: () => number;
}

/**
 * One global bucket. Loopback peers cannot be distinguished cheaply via
 * remoteAddress, so the daemon deliberately does not pretend to provide
 * per-client fairness.
 */
export class TokenBucket {
  readonly #capacity: number;
  readonly #refillPerSecond: number;
  readonly #clock: () => number;
  #tokens: number;
  #last: number;

  constructor(options: TokenBucketOptions = {}) {
    this.#capacity = options.capacity ?? 20;
    this.#refillPerSecond = options.refillPerSecond ?? 2;
    this.#clock = options.clock ?? ((): number => performance.now());
    this.#tokens = this.#capacity;
    this.#last = this.#clock();
  }

  take(): boolean {
    const now = this.#clock();
    const elapsedSeconds = Math.max(0, (now - this.#last) / 1000);
    this.#last = now;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsedSeconds * this.#refillPerSecond);
    if (this.#tokens < 1) {
      return false;
    }
    this.#tokens -= 1;
    return true;
  }
}

export function oneQueryValue(value: unknown): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') {
    return value[0];
  }
  throw new ApiError('invalid_request');
}

export function parseListLimit(value: unknown): number {
  const raw = oneQueryValue(value);
  if (raw === undefined) {
    return API_DEFAULT_LIST_LIMIT;
  }
  if (!/^[0-9]+$/u.test(raw)) {
    throw new ApiError('invalid_request');
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > API_MAX_LIST_LIMIT) {
    throw new ApiError('invalid_request');
  }
  return limit;
}

export function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const raw = oneQueryValue(value);
  if (raw === undefined) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ApiError('invalid_request');
  }
  return raw as T;
}

/** Persona path parameters must satisfy the authoritative contracts identity. */
export function parsePersonaId(value: unknown): PersonaId {
  if (!isPersonaId(value)) {
    throw new ApiError('invalid_request');
  }
  return value;
}

/** Other path parameters are opaque here; the Runtime validates their branded id. */
export function parseId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new ApiError('invalid_request');
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new ApiError('invalid_request');
    }
  }
  return value;
}
