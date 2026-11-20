/**
 * In-process P1 ingress (SH-008C).
 *
 * Order, matching RUNTIME-LIFECYCLE §7.1 for the Archive-off path:
 *   1. Validate `soul.stimulus.input.v1` (no `receivedAt`, no unknown fields).
 *   2. Stamp `receivedAt` from the injected clock and validate `soul.stimulus.v1`.
 *   3. Dedupe on `(personaId, adapterId, source, adapterEventRef)`.
 *      A hit returns the existing row. P1 cannot compare bodies, so the hit
 *      only increments `dedupe.body_unverifiable`. It does not write, it does
 *      not buffer, and it does not claim the bodies match. Terminal rows stay
 *      terminal.
 *   4. Otherwise allocate an event id, reuse or create the open session, and
 *      commit `received` → `accepted` (or `expired` / `queue_overflow`) in one
 *      persistence transaction. Archive columns stay at their defaults.
 *   5. Return only after that transaction has committed. The body, if kept,
 *      is stored in the persona's memory buffer after the commit.
 *
 * Same-persona accepts and TTL closes share one queue. Other personas do not.
 * This module does not open SQLite, does not call Archive, and does not move
 * an event to noticed / understood / response_committed / acted.
 */

import { isEventId, isPersonaId, isSessionId, isSourceId } from '@soul-harness/contracts';
import type {
  AdapterId,
  EventId,
  EventStatus,
  PersonaId,
  SessionId,
  SourceId,
  StimulusV1,
} from '@soul-harness/contracts';
import {
  ACTIVE_SESSION_EXTERNAL_ID_MAX_LENGTH,
  Store,
  createRepositories,
  isPersistenceError,
  withRead,
} from '@soul-harness/persistence';
import type { EventRow, PersonaRow } from '@soul-harness/persistence';

import { RuntimeError } from '../errors.js';
import { ID_ALLOCATION_MAX_ATTEMPTS, allocateEventId, allocateSessionId } from '../ids/allocate.js';
import type { RuntimeLogFields, RuntimeLogger } from '../persona/lifecycle.js';
import { createKeyedQueue } from '../persona/queue.js';
import {
  createDefaultIngressScheduler,
  createPerceptionBuffer,
  type BufferSlot,
  type IngressScheduler,
} from './buffer.js';
import { normalizeStimulus, parseStimulusInput } from './schema.js';

/** Protocol metric. A counter, not a status and not a claim that bodies match. */
export const DEDUPE_BODY_UNVERIFIABLE_METRIC = 'dedupe.body_unverifiable' as const;

export interface IngressChannelLimits {
  readonly queueCapacity: number;
  readonly bufferTtlMs: number;
}

/**
 * Required limits. Missing or illegal values throw at construction.
 * There is no silent unlimited default.
 *
 * `channels` replaces both limits for that source. Each persona has its own
 * counter per source; the numbers are the cap, not a shared pool.
 */
export interface StimulusIngressConfig {
  readonly queueCapacity: number;
  readonly bufferTtlMs: number;
  readonly channels?: Readonly<Record<string, IngressChannelLimits>>;
}

/** View of a write that is about to happen. No payload, no nonce, no body. */
export interface IngressPersistView {
  readonly personaId: PersonaId;
  readonly adapterId: AdapterId;
  readonly source: SourceId;
  readonly adapterEventRef: string;
  readonly eventId: EventId;
  readonly outcome: 'accepted' | 'queue_overflow';
}

export interface StimulusIngressOptions {
  readonly store: Store;
  readonly logger: RuntimeLogger;
  /** Unix milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /** Forwarded to event and session id allocation. Default `crypto.randomBytes`. */
  readonly randomBytes?: (size: number) => Uint8Array;
  /** Timer implementation. Default `setTimeout` / `clearTimeout`. */
  readonly timers?: IngressScheduler;
  readonly config: StimulusIngressConfig;
  /**
   * Test seam. Invoked inside the persona queue after the id is chosen and
   * the session is resolved, and before the envelope commit. A returned
   * promise is awaited. Not called on the dedupe-hit path.
   */
  readonly beforePersist?: (view: IngressPersistView) => void | Promise<void>;
  /**
   * Test seam. Invoked inside the admission read, after the persona row is
   * read and before the dedupe lookup. A second connection can commit there;
   * this connection still sees the pre-commit snapshot.
   */
  readonly duringRead?: () => void;
}

export interface IngressAccepted {
  readonly outcome: 'accepted';
  readonly eventId: EventId;
  readonly status: 'accepted';
  readonly sessionId: SessionId | null;
  readonly receivedAt: number;
  readonly occurredAt: number | null;
  readonly archiveState: 'none';
  /** P1 acceptance means the envelope was committed. It is not an audit. */
  readonly audited: false;
}

export interface IngressDuplicate {
  readonly outcome: 'duplicate';
  readonly eventId: EventId;
  readonly status: EventStatus;
  readonly sessionId: SessionId | null;
  /** Always false. P1 did not compare bodies and must not claim they match. */
  readonly bodyVerified: false;
}

export interface IngressRefused {
  readonly outcome: 'refused';
  readonly eventId: EventId;
  readonly status: 'expired';
  readonly reason: 'queue_overflow';
  readonly sessionId: SessionId | null;
}

export type IngressResult = IngressAccepted | IngressDuplicate | IngressRefused;

export interface AcceptStimulusInput {
  /** Closed `soul.stimulus.input.v1` document. `receivedAt` is rejected. */
  readonly stimulus: unknown;
  /**
   * Adapter session key. Stored as `sessions.external_id` when present.
   * Not part of the stimulus schema. Message text does not belong here.
   */
  readonly externalSessionRef?: string;
}

export interface BufferedStimulus {
  readonly eventId: EventId;
  readonly personaId: PersonaId;
  readonly source: SourceId;
  readonly receivedAt: number;
  readonly occurredAt: number | null;
  readonly expiresAt: number;
  readonly payload: StimulusV1['payload'];
}

export interface QueuedStimulus {
  readonly eventId: EventId;
  readonly personaId: PersonaId;
  readonly source: SourceId;
  readonly receivedAt: number;
  readonly expiresAt: number;
}

export interface TtlClose {
  readonly eventId: EventId;
  readonly personaId: PersonaId;
  readonly reason: 'ttl_expired';
}

export interface IngressMetrics {
  readonly 'dedupe.body_unverifiable': number;
}

export interface StimulusIngress {
  acceptStimulus(input: AcceptStimulusInput): Promise<IngressResult>;
  /** Body for this persona only, or null when it is absent or past TTL. */
  readBuffered(personaId: PersonaId, eventId: EventId): BufferedStimulus | null;
  /** Metadata only, ordered by `receivedAt` then `eventId`. No payload. */
  listQueued(personaId: PersonaId): readonly QueuedStimulus[];
  /** Close due buffers using the injected clock. Does not rewrite terminal rows. */
  evictExpired(): Promise<readonly TtlClose[]>;
  /** Drop every buffered body and cancel every timer. Idempotent. */
  close(): void;
  metrics(): IngressMetrics;
}

const CONFIG_KEYS = new Set(['queueCapacity', 'bufferTtlMs', 'channels']);
const LIMIT_KEYS = new Set(['queueCapacity', 'bufferTtlMs']);
const WRAPPER_KEYS = new Set(['stimulus', 'externalSessionRef']);

export function createStimulusIngress(options: StimulusIngressOptions): StimulusIngress {
  assertOptions(options);
  const clock = options.now ?? Date.now;
  const repos = createRepositories(options.store);
  const queue = createKeyedQueue();
  const scheduler = options.timers ?? createDefaultIngressScheduler();
  const buffer = createPerceptionBuffer({ now: readClock, scheduler });
  let unverifiable = 0;
  let closed = false;

  function readClock(): number {
    let value: number;
    try {
      value = clock();
    } catch (error) {
      throw new RuntimeError('invalid_clock', 'clock threw', { cause: error });
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RuntimeError('invalid_clock', 'clock must return a non-negative safe integer');
    }
    return value;
  }

  function safeLog(
    level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    fields?: RuntimeLogFields,
  ): void {
    try {
      options.logger[level](event, fields);
    } catch {
      // A diagnostic failure must not replace a committed row or a rejection.
    }
  }

  function limitsFor(source: SourceId): IngressChannelLimits {
    const override = options.config.channels?.[source];
    if (override !== undefined) {
      return override;
    }
    return {
      queueCapacity: options.config.queueCapacity,
      bufferTtlMs: options.config.bufferTtlMs,
    };
  }

  function duplicateOf(row: EventRow): IngressDuplicate {
    unverifiable += 1;
    safeLog('info', 'ingress.dedupe_unverifiable', {
      eventId: row.id,
      personaId: row.personaId,
      adapterId: row.adapterId,
      source: row.source,
      adapterEventRef: row.adapterEventRef,
      status: row.status,
      metric: DEDUPE_BODY_UNVERIFIABLE_METRIC,
      bodyVerified: false,
    });
    return {
      outcome: 'duplicate',
      eventId: row.id,
      status: row.status,
      sessionId: row.sessionId,
      bodyVerified: false,
    };
  }

  function expireIfDue(slot: BufferSlot): TtlClose | null {
    const current = buffer.peek(slot.personaId, slot.eventId);
    if (current === null) {
      return null;
    }
    const now = readClock();
    if (current.expiresAt > now) {
      buffer.rearm(current.personaId, current.eventId);
      return null;
    }
    const row = repos.events.expireActive({
      id: current.eventId,
      personaId: current.personaId,
      updatedAt: now,
      reason: 'ttl_expired',
    });
    buffer.take(current.personaId, current.eventId);
    if (row === null) {
      return null;
    }
    safeLog('info', 'ingress.ttl_expired', {
      eventId: row.id,
      personaId: row.personaId,
      adapterId: row.adapterId,
      source: row.source,
      status: row.status,
      reason: 'ttl_expired',
    });
    return { eventId: row.id, personaId: row.personaId, reason: 'ttl_expired' };
  }

  function evictPersona(personaId: PersonaId, now: number): void {
    for (const slot of buffer.due(personaId, now)) {
      expireIfDue(slot);
    }
  }

  function onDue(slot: BufferSlot): void {
    void queue
      .run(slot.personaId, () => expireIfDue(slot))
      .catch(() => {
        safeLog('error', 'ingress.ttl_failed', {
          personaId: slot.personaId,
          eventId: slot.eventId,
          reason: 'ttl_expired',
        });
      });
  }

  function readAdmission(stimulus: StimulusV1): {
    readonly persona: PersonaRow | null;
    readonly existing: EventRow | null;
  } {
    return withRead(options.store, () => {
      const persona = repos.personas.getById(stimulus.personaId);
      options.duringRead?.();
      const existing = repos.events.findByDedupeKey({
        personaId: stimulus.personaId,
        adapterId: stimulus.adapterId,
        source: stimulus.source,
        adapterEventRef: stimulus.adapterEventRef,
      });
      return { persona, existing };
    });
  }

  function openSession(
    personaId: PersonaId,
    adapterId: AdapterId,
    externalId: string,
    openedAt: number,
  ): SessionId {
    for (let attempt = 1; attempt <= ID_ALLOCATION_MAX_ATTEMPTS; attempt += 1) {
      const id = allocateSessionId({
        now: () => openedAt,
        isOccupied: (candidate) =>
          isSessionId(candidate) && repos.sessions.getById(candidate) !== null,
        ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
      });
      try {
        const opened = repos.sessions.openActive({
          id,
          personaId,
          adapterId,
          externalId,
          openedAt,
        });
        return opened.session.id;
      } catch (error) {
        if (isPersistenceError(error) && error.code === 'unique_conflict') {
          continue;
        }
        if (isPersistenceError(error) && error.code === 'foreign_key_violation') {
          throw new RuntimeError('not_found', 'persona does not exist', {
            cause: error,
            details: { operation: 'acceptStimulus' },
          });
        }
        throw error;
      }
    }
    throw new RuntimeError('id_collision', 'session id allocation exhausted its retry budget', {
      details: { prefix: 'ses', attempts: ID_ALLOCATION_MAX_ATTEMPTS },
    });
  }

  async function commitEnvelope(
    stimulus: StimulusV1,
    sessionId: SessionId | null,
    outcome: 'accepted' | 'queue_overflow',
  ): Promise<
    | { readonly kind: 'created'; readonly row: EventRow }
    | { readonly kind: 'duplicate'; readonly row: EventRow }
  > {
    for (let attempt = 1; attempt <= ID_ALLOCATION_MAX_ATTEMPTS; attempt += 1) {
      const eventId = allocateEventId({
        now: () => stimulus.receivedAt,
        isOccupied: (candidate) => isEventId(candidate) && repos.events.getById(candidate) !== null,
        ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
      });
      const waited = options.beforePersist?.({
        personaId: stimulus.personaId,
        adapterId: stimulus.adapterId,
        source: stimulus.source,
        adapterEventRef: stimulus.adapterEventRef,
        eventId,
        outcome,
      });
      if (isThenable(waited)) {
        await waited;
      }
      if (closed) {
        throw new RuntimeError('closed', 'ingress is closed');
      }
      try {
        const row = repos.events.commitP1Envelope({
          id: eventId,
          personaId: stimulus.personaId,
          source: stimulus.source,
          adapterId: stimulus.adapterId,
          adapterEventRef: stimulus.adapterEventRef,
          receivedAt: stimulus.receivedAt,
          updatedAt: stimulus.receivedAt,
          ...(sessionId === null ? {} : { sessionId }),
          ...(stimulus.occurredAt === undefined ? {} : { occurredAt: stimulus.occurredAt }),
          outcome:
            outcome === 'accepted'
              ? { status: 'accepted' }
              : { status: 'expired', reason: 'queue_overflow' },
        });
        return { kind: 'created', row };
      } catch (error) {
        if (isPersistenceError(error) && error.code === 'unique_conflict') {
          const existing = repos.events.findByDedupeKey({
            personaId: stimulus.personaId,
            adapterId: stimulus.adapterId,
            source: stimulus.source,
            adapterEventRef: stimulus.adapterEventRef,
          });
          if (existing !== null) {
            return { kind: 'duplicate', row: existing };
          }
          continue;
        }
        if (isPersistenceError(error) && error.code === 'foreign_key_violation') {
          throw new RuntimeError('not_found', 'persona does not exist', {
            cause: error,
            details: { operation: 'acceptStimulus' },
          });
        }
        throw error;
      }
    }
    throw new RuntimeError('id_collision', 'event id allocation exhausted its retry budget', {
      details: { prefix: 'evt', attempts: ID_ALLOCATION_MAX_ATTEMPTS },
    });
  }

  function remember(row: EventRow, stimulus: StimulusV1, expiresAt: number): void {
    buffer.put(
      {
        personaId: row.personaId,
        eventId: row.id,
        source: row.source,
        receivedAt: row.receivedAt,
        occurredAt: row.occurredAt,
        expiresAt,
        payload: stimulus.payload,
      },
      onDue,
    );
  }

  function finishCreated(row: EventRow, outcome: 'accepted' | 'queue_overflow'): IngressResult {
    if (outcome === 'queue_overflow') {
      safeLog('warn', 'ingress.queue_overflow', {
        eventId: row.id,
        personaId: row.personaId,
        adapterId: row.adapterId,
        source: row.source,
        status: row.status,
        reason: 'queue_overflow',
      });
      return {
        outcome: 'refused',
        eventId: row.id,
        status: 'expired',
        reason: 'queue_overflow',
        sessionId: row.sessionId,
      };
    }
    safeLog('info', 'ingress.accepted', {
      eventId: row.id,
      personaId: row.personaId,
      adapterId: row.adapterId,
      source: row.source,
      sessionId: row.sessionId,
      status: row.status,
      receivedAt: row.receivedAt,
    });
    return {
      outcome: 'accepted',
      eventId: row.id,
      status: 'accepted',
      sessionId: row.sessionId,
      receivedAt: row.receivedAt,
      occurredAt: row.occurredAt,
      archiveState: 'none',
      audited: false,
    };
  }

  async function admit(parsed: ParsedStimulus): Promise<IngressResult> {
    if (closed) {
      throw new RuntimeError('closed', 'ingress is closed');
    }
    const now = readClock();
    const stimulus = normalizeStimulus(parsed.stimulus, now);
    evictPersona(stimulus.personaId, now);
    const admission = readAdmission(stimulus);
    if (admission.persona === null) {
      throw new RuntimeError('not_found', 'persona does not exist', {
        details: { operation: 'acceptStimulus' },
      });
    }
    if (admission.existing !== null) {
      return duplicateOf(admission.existing);
    }

    const limits = limitsFor(stimulus.source);
    const occupied = buffer.count(stimulus.personaId, stimulus.source);
    const outcome = occupied >= limits.queueCapacity ? 'queue_overflow' : 'accepted';
    if (outcome === 'accepted') {
      const expiresAt = now + limits.bufferTtlMs;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new RuntimeError('invalid_argument', 'buffer expiry is not a safe integer', {
          details: { field: 'bufferTtlMs' },
        });
      }
    }

    const sessionId =
      parsed.externalSessionRef === undefined
        ? null
        : openSession(stimulus.personaId, stimulus.adapterId, parsed.externalSessionRef, now);
    const written = await commitEnvelope(stimulus, sessionId, outcome);
    if (written.kind === 'duplicate') {
      return duplicateOf(written.row);
    }
    if (outcome === 'accepted' && !closed) {
      const expiresAt = now + limits.bufferTtlMs;
      try {
        remember(written.row, stimulus, expiresAt);
      } catch {
        safeLog('error', 'ingress.buffer_failed', {
          eventId: written.row.id,
          personaId: written.row.personaId,
        });
      }
    }
    return finishCreated(written.row, outcome);
  }

  return {
    async acceptStimulus(input) {
      if (closed) {
        throw new RuntimeError('closed', 'ingress is closed');
      }
      let parsed: ParsedStimulus;
      try {
        parsed = parseWrapper(input);
      } catch (error) {
        if (error instanceof RuntimeError && error.code === 'schema_invalid') {
          const schema = error.details?.['schema'];
          safeLog('warn', 'ingress.schema_invalid', {
            schema: typeof schema === 'string' ? schema : 'soul.stimulus.input.v1',
          });
        }
        throw error;
      }
      return queue.run(parsed.stimulus.personaId, () => admit(parsed));
    },

    readBuffered(personaId, eventId) {
      assertPersonaId(personaId);
      if (!isEventId(eventId)) {
        throw new RuntimeError('invalid_argument', 'eventId must be an event id', {
          details: { field: 'eventId' },
        });
      }
      const slot = buffer.peek(personaId, eventId);
      if (slot === null) {
        return null;
      }
      return {
        eventId: slot.eventId,
        personaId: slot.personaId,
        source: slot.source,
        receivedAt: slot.receivedAt,
        occurredAt: slot.occurredAt,
        expiresAt: slot.expiresAt,
        payload: structuredClone(slot.payload),
      };
    },

    listQueued(personaId) {
      assertPersonaId(personaId);
      return buffer.list(personaId).map((slot) => ({
        eventId: slot.eventId,
        personaId: slot.personaId,
        source: slot.source,
        receivedAt: slot.receivedAt,
        expiresAt: slot.expiresAt,
      }));
    },

    async evictExpired() {
      if (closed) {
        return [];
      }
      const now = readClock();
      const groups = new Map<PersonaId, BufferSlot[]>();
      for (const slot of buffer.dueAll(now)) {
        const group = groups.get(slot.personaId);
        if (group === undefined) {
          groups.set(slot.personaId, [slot]);
        } else {
          group.push(slot);
        }
      }
      const batches = await Promise.all(
        [...groups.entries()].map(([personaId, slots]) =>
          queue.run(personaId, () => {
            const closedSlots: TtlClose[] = [];
            for (const slot of slots) {
              const result = expireIfDue(slot);
              if (result !== null) {
                closedSlots.push(result);
              }
            }
            return closedSlots;
          }),
        ),
      );
      return batches.flat();
    },

    close() {
      closed = true;
      buffer.clear();
    },

    metrics() {
      return { [DEDUPE_BODY_UNVERIFIABLE_METRIC]: unverifiable };
    },
  };
}

interface ParsedStimulus {
  readonly stimulus: ReturnType<typeof parseStimulusInput>;
  readonly externalSessionRef?: string;
}

function parseWrapper(input: unknown): ParsedStimulus {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new RuntimeError('invalid_argument', 'acceptStimulus input must be an object');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!WRAPPER_KEYS.has(key)) {
      const field = safeField(key);
      throw new RuntimeError('invalid_argument', 'acceptStimulus input has an unknown field', {
        ...(field === undefined ? {} : { details: { field } }),
      });
    }
  }
  if (!('stimulus' in record)) {
    throw new RuntimeError('invalid_argument', 'acceptStimulus input requires stimulus', {
      details: { field: 'stimulus' },
    });
  }
  let externalSessionRef: string | undefined;
  if ('externalSessionRef' in record) {
    externalSessionRef = assertExternalSessionRef(record['externalSessionRef']);
  }
  let stimulus: ReturnType<typeof parseStimulusInput>;
  try {
    stimulus = parseStimulusInput(record['stimulus']);
  } catch (error) {
    if (error instanceof RuntimeError) {
      throw error;
    }
    throw new RuntimeError('schema_invalid', 'stimulus failed schema validation', {
      cause: error,
      details: { schema: 'soul.stimulus.input.v1' },
    });
  }
  return {
    stimulus,
    ...(externalSessionRef === undefined ? {} : { externalSessionRef }),
  };
}

function assertExternalSessionRef(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > ACTIVE_SESSION_EXTERNAL_ID_MAX_LENGTH ||
    value !== value.trim()
  ) {
    throw new RuntimeError(
      'invalid_argument',
      'externalSessionRef must be a trimmed string of 1 to 256 characters',
      {
        details: { field: 'externalSessionRef', maxLength: ACTIVE_SESSION_EXTERNAL_ID_MAX_LENGTH },
      },
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 127) {
      throw new RuntimeError(
        'invalid_argument',
        'externalSessionRef must not contain whitespace or control characters',
        { details: { field: 'externalSessionRef' } },
      );
    }
  }
  return value;
}

function safeField(key: string): string | undefined {
  return /^[A-Za-z0-9._:-]{1,64}$/u.test(key) ? key : undefined;
}

function assertPersonaId(personaId: PersonaId): void {
  if (!isPersonaId(personaId)) {
    throw new RuntimeError('invalid_argument', 'personaId must be a persona id', {
      details: { field: 'personaId' },
    });
  }
}

function assertOptions(options: StimulusIngressOptions): void {
  if (typeof options !== 'object' || options === null) {
    throw new RuntimeError('invalid_argument', 'ingress options must be an object');
  }
  if (!(options.store instanceof Store)) {
    throw new RuntimeError('invalid_argument', 'store must be a Store', {
      details: { field: 'store' },
    });
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new RuntimeError('invalid_argument', 'now must be a function', {
      details: { field: 'now' },
    });
  }
  if (options.randomBytes !== undefined && typeof options.randomBytes !== 'function') {
    throw new RuntimeError('invalid_argument', 'randomBytes must be a function', {
      details: { field: 'randomBytes' },
    });
  }
  if (options.beforePersist !== undefined && typeof options.beforePersist !== 'function') {
    throw new RuntimeError('invalid_argument', 'beforePersist must be a function', {
      details: { field: 'beforePersist' },
    });
  }
  if (options.duringRead !== undefined && typeof options.duringRead !== 'function') {
    throw new RuntimeError('invalid_argument', 'duringRead must be a function', {
      details: { field: 'duringRead' },
    });
  }
  if (options.timers !== undefined) {
    if (
      typeof options.timers !== 'object' ||
      options.timers === null ||
      typeof options.timers.schedule !== 'function'
    ) {
      throw new RuntimeError('invalid_argument', 'timers.schedule must be a function', {
        details: { field: 'timers' },
      });
    }
  }
  assertLogger(options.logger);
  assertConfig(options.config);
}

function assertLogger(logger: RuntimeLogger): void {
  if (
    typeof logger !== 'object' ||
    logger === null ||
    typeof logger.debug !== 'function' ||
    typeof logger.info !== 'function' ||
    typeof logger.warn !== 'function' ||
    typeof logger.error !== 'function'
  ) {
    throw new RuntimeError('invalid_argument', 'logger must provide debug, info, warn, and error', {
      details: { field: 'logger' },
    });
  }
}

function assertConfig(config: StimulusIngressConfig): void {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new RuntimeError('invalid_argument', 'ingress config must be an object', {
      details: { field: 'config' },
    });
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new RuntimeError('invalid_argument', 'ingress config has an unknown field', {
        details: { field: key },
      });
    }
  }
  assertLimit(config.queueCapacity, 'queueCapacity');
  assertLimit(config.bufferTtlMs, 'bufferTtlMs');
  if (config.channels === undefined) {
    return;
  }
  if (
    typeof config.channels !== 'object' ||
    config.channels === null ||
    Array.isArray(config.channels)
  ) {
    throw new RuntimeError('invalid_argument', 'channels must be an object', {
      details: { field: 'channels' },
    });
  }
  for (const [source, limits] of Object.entries(config.channels)) {
    if (!isSourceId(source)) {
      throw new RuntimeError('invalid_argument', 'channel key must be a source id', {
        details: { field: 'channels' },
      });
    }
    if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
      throw new RuntimeError('invalid_argument', 'channel limits must be an object', {
        details: { field: 'channels' },
      });
    }
    for (const key of Object.keys(limits)) {
      if (!LIMIT_KEYS.has(key)) {
        throw new RuntimeError('invalid_argument', 'channel limits have an unknown field', {
          details: { field: key },
        });
      }
    }
    assertLimit(limits.queueCapacity, 'queueCapacity');
    assertLimit(limits.bufferTtlMs, 'bufferTtlMs');
  }
}

function assertLimit(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RuntimeError('invalid_argument', `${field} must be a positive safe integer`, {
      details: { field },
    });
  }
}

function isThenable(value: unknown): value is Promise<void> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}
