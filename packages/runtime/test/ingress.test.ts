/**
 * P1 ingress against a real migrated SQLite file.
 *
 * Bodies are checked by scanning every P1 table and the captured logs. The
 * authoritative database is not mocked.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STIMULUS_INPUT_VERSION,
  isEventId,
  isSessionId,
  type AdapterId,
  type EventId,
  type PersonaId,
  type SourceId,
} from '@soul-harness/contracts';
import {
  createRepositories,
  migrate,
  openStore,
  withRead,
  type Store,
} from '@soul-harness/persistence';
import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultIngressScheduler } from '../src/events/buffer.js';
import {
  DEDUPE_BODY_UNVERIFIABLE_METRIC,
  ID_ENTROPY_BYTES,
  RuntimeError,
  allocateEventId,
  allocatePersonaId,
  createStimulusIngress,
} from '../src/index.js';
import type {
  AcceptStimulusInput,
  IngressPersistView,
  IngressScheduler,
  RuntimeLogFields,
  RuntimeLogger,
  StimulusIngress,
  StimulusIngressConfig,
} from '../src/index.js';

const ADAPTER = 'minecraft' as AdapterId;
const SOURCE = 'minecraft.chat' as SourceId;
const CANARY = 'CANARY-SH008C-正文-9f3e2a7c';
const OTHER_BODY = 'OTHER-BODY-SH008C-should-not-stick';
const TABLES = [
  'personas',
  'sessions',
  'events',
  'tasks',
  'runtime_state',
  'schema_migrations',
] as const;

interface CapturedLog {
  readonly level: string;
  readonly event: string;
  readonly fields?: RuntimeLogFields;
}

interface ManualTimer {
  delay: number;
  cancelled: boolean;
  fired: boolean;
  fire: () => void;
}

class ManualScheduler implements IngressScheduler {
  readonly timers: ManualTimer[] = [];

  schedule(delayMs: number, fire: () => void): { cancel(): void } {
    const timer: ManualTimer = {
      delay: delayMs,
      cancelled: false,
      fired: false,
      fire: () => {
        timer.fired = true;
        fire();
      },
    };
    this.timers.push(timer);
    return {
      cancel() {
        timer.cancelled = true;
      },
    };
  }

  /** Timers that have neither run nor been cancelled. */
  active(): number {
    return this.timers.filter((timer) => !timer.cancelled && !timer.fired).length;
  }
}

interface Fixture {
  readonly store: Store;
  readonly dir: string;
  readonly logs: CapturedLog[];
  readonly logger: RuntimeLogger;
  readonly scheduler: ManualScheduler;
  time: number;
}

const fixtures: Fixture[] = [];

function remember(fixture: Fixture): Fixture {
  fixtures.push(fixture);
  return fixture;
}

function openFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'sh-ingress-'));
  const store = openStore({ file: join(dir, 'soul.db') });
  migrate(store);
  const logs: CapturedLog[] = [];
  const record =
    (level: string) =>
    (event: string, fields?: RuntimeLogFields): void => {
      logs.push(fields === undefined ? { level, event } : { level, event, fields });
    };
  return remember({
    store,
    dir,
    logs,
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    scheduler: new ManualScheduler(),
    time: 5_000_000,
  });
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop() as Fixture;
    fixture.store.close();
    rmSync(fixture.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

function fill(value: number): Uint8Array {
  return new Uint8Array(ID_ENTROPY_BYTES).fill(value);
}

function seedPersona(store: Store, id: PersonaId, name = 'Ingress'): void {
  createRepositories(store).personas.insert({
    id,
    displayName: name,
    state: 'RUNNING',
    createdAt: 1,
    updatedAt: 1,
  });
}

function persona(byte: number): PersonaId {
  return allocatePersonaId({ now: () => 1_000, randomBytes: () => fill(byte) });
}

function eventId(byte: number): EventId {
  return allocateEventId({ now: () => 2_000, randomBytes: () => fill(byte) });
}

const DEFAULTS: StimulusIngressConfig = {
  queueCapacity: 4,
  bufferTtlMs: 60_000,
  personaAdmissionCapacity: 8,
};

type IngressTestConfig = {
  readonly queueCapacity: number;
  readonly bufferTtlMs: number;
  readonly personaAdmissionCapacity?: number;
  readonly channels?: StimulusIngressConfig['channels'];
};

function toIngressConfig(config: IngressTestConfig): StimulusIngressConfig {
  return {
    queueCapacity: config.queueCapacity,
    bufferTtlMs: config.bufferTtlMs,
    personaAdmissionCapacity: config.personaAdmissionCapacity ?? DEFAULTS.personaAdmissionCapacity,
    ...(config.channels === undefined ? {} : { channels: config.channels }),
  };
}

function ingress(
  fixture: Fixture,
  extra: {
    readonly config?: IngressTestConfig;
    readonly randomBytes?: (size: number) => Uint8Array;
    readonly beforePersist?: (view: IngressPersistView) => void | Promise<void>;
    readonly duringRead?: () => void;
    readonly beforeExpire?: () => void;
    readonly logger?: RuntimeLogger;
    readonly timers?: IngressScheduler;
    readonly now?: () => number;
  } = {},
): StimulusIngress {
  return createStimulusIngress({
    store: fixture.store,
    logger: extra.logger ?? fixture.logger,
    timers: extra.timers === undefined ? fixture.scheduler : extra.timers,
    now: extra.now ?? (() => fixture.time),
    config: extra.config === undefined ? DEFAULTS : toIngressConfig(extra.config),
    ...(extra.randomBytes === undefined ? {} : { randomBytes: extra.randomBytes }),
    ...(extra.beforePersist === undefined ? {} : { beforePersist: extra.beforePersist }),
    ...(extra.duringRead === undefined ? {} : { duringRead: extra.duringRead }),
    ...(extra.beforeExpire === undefined ? {} : { beforeExpire: extra.beforeExpire }),
  });
}

function envelope(
  personaId: PersonaId,
  ref: string,
  extra: Record<string, unknown> = {},
): AcceptStimulusInput {
  return {
    stimulus: {
      schema: STIMULUS_INPUT_VERSION,
      personaId,
      adapterId: 'minecraft',
      source: 'minecraft.chat',
      adapterEventRef: ref,
      requestNonce: 'NQ7xK2mR9tVb4Wc8',
      payload: { kind: 'mc.world', version: 1 },
      ...extra,
    },
  };
}

function dump(store: Store): string {
  return withRead(store, (tx) =>
    TABLES.map((table) => JSON.stringify(tx.prepare(`SELECT * FROM ${table}`).all())).join('\n'),
  );
}

function eventOf(result: { readonly eventId: EventId | null }): EventId {
  if (result.eventId === null) {
    throw new Error('expected an event id');
  }
  return result.eventId;
}

function promiseOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return run();
  } catch (error) {
    throw new Error('call threw synchronously', { cause: error });
  }
}

function throwingLogger(method: 'info' | 'warn'): RuntimeLogger {
  const fail = (): void => {
    throw new Error('log-failed');
  };
  const noop = (): void => {};
  return {
    debug: noop,
    info: method === 'info' ? fail : noop,
    warn: method === 'warn' ? fail : noop,
    error: noop,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out');
}

describe('ingress — schema and clock', () => {
  it('accepts a minimal envelope and stamps receivedAt from the injected clock', async () => {
    const fixture = openFixture();
    const id = persona(1);
    seedPersona(fixture.store, id);
    fixture.time = 8_000;
    const bus = ingress(fixture);

    const result = await bus.acceptStimulus(envelope(id, 'mc-7f3a9c21'));

    expect(result).toMatchObject({
      outcome: 'accepted',
      status: 'accepted',
      receivedAt: 8_000,
      occurredAt: null,
      archiveState: 'none',
      audited: false,
      sessionId: null,
    });
    expect(isEventId(result.eventId)).toBe(true);
    const row = createRepositories(fixture.store).events.getById(eventOf(result));
    expect(row).toMatchObject({
      status: 'accepted',
      statusReason: null,
      receivedAt: 8_000,
      occurredAt: null,
      summary: null,
      archiveRef: null,
      archiveDisposition: null,
      archiveState: 'none',
      sessionId: null,
    });
    expect(bus.metrics()[DEDUPE_BODY_UNVERIFIABLE_METRIC]).toBe(0);
  });

  it('keeps a late occurredAt beside receivedAt', async () => {
    const fixture = openFixture();
    const id = persona(2);
    seedPersona(fixture.store, id);
    fixture.time = 9_000_000;
    const bus = ingress(fixture);

    const result = await bus.acceptStimulus(
      envelope(id, 'mc-late', {
        occurredAt: 10,
        payload: { kind: 'qq.message', version: 2, text: 'hello' },
      }),
    );

    expect(result).toMatchObject({ outcome: 'accepted', receivedAt: 9_000_000, occurredAt: 10 });
    expect(createRepositories(fixture.store).events.getById(eventOf(result))).toMatchObject({
      occurredAt: 10,
      receivedAt: 9_000_000,
    });
  });

  it('rejects receivedAt and unknown top-level fields without writing', async () => {
    const fixture = openFixture();
    const id = persona(3);
    seedPersona(fixture.store, id);
    const bus = ingress(fixture);

    const withReceipt = promiseOf(() =>
      bus.acceptStimulus(envelope(id, 'mc-7f3a9c21', { receivedAt: 1 })),
    );
    await expect(withReceipt).rejects.toMatchObject({ code: 'schema_invalid' });

    const unknown = promiseOf(() => bus.acceptStimulus(envelope(id, 'mc-7f3a9c21', { note: 'x' })));
    await expect(unknown).rejects.toMatchObject({ code: 'schema_invalid' });

    const wrapper = promiseOf(() =>
      bus.acceptStimulus({
        ...envelope(id, 'mc-7f3a9c21'),
        receivedAt: 1,
      } as AcceptStimulusInput),
    );
    await expect(wrapper).rejects.toMatchObject({ code: 'invalid_argument' });

    expect(
      createRepositories(fixture.store).events.listByPersonaStatus({
        personaId: id,
        status: 'accepted',
      }),
    ).toEqual([]);
    expect(dump(fixture.store).includes('mc-7f3a9c21')).toBe(false);
  });

  it('rejects a missing persona and an illegal call on the returned promise', async () => {
    const fixture = openFixture();
    const id = persona(4);
    const bus = ingress(fixture);

    const missing = promiseOf(() => bus.acceptStimulus(envelope(id, 'mc-missing')));
    await expect(missing).rejects.toMatchObject({ name: 'RuntimeError', code: 'not_found' });

    const empty = promiseOf(() => bus.acceptStimulus(null as unknown as AcceptStimulusInput));
    await expect(empty).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(dump(fixture.store).includes('mc-missing')).toBe(false);
  });
});

describe('ingress — dedupe without a body comparison', () => {
  it('returns the existing event, increments the unverifiable metric, and does not insert', async () => {
    const fixture = openFixture();
    const id = persona(5);
    seedPersona(fixture.store, id);
    const bus = ingress(fixture);
    const first = await bus.acceptStimulus({
      stimulus: {
        ...(envelope(id, 'mc-same').stimulus as object),
        payload: { kind: 'mc.world', version: 1, text: 'first-body' },
      },
    });
    const second = await bus.acceptStimulus({
      stimulus: {
        ...(envelope(id, 'mc-same').stimulus as object),
        payload: { kind: 'mc.world', version: 1, text: OTHER_BODY },
      },
    });

    expect(first.outcome).toBe('accepted');
    expect(second).toMatchObject({
      outcome: 'duplicate',
      eventId: first.eventId,
      status: 'accepted',
      bodyVerified: false,
    });
    expect(bus.metrics()[DEDUPE_BODY_UNVERIFIABLE_METRIC]).toBe(1);
    expect(
      createRepositories(fixture.store).events.listByPersonaStatus({
        personaId: id,
        status: 'accepted',
      }),
    ).toHaveLength(1);
    expect(bus.readBuffered(id, eventOf(first))?.payload).toMatchObject({ text: 'first-body' });
    expect(JSON.stringify(bus.readBuffered(id, eventOf(first)))).not.toContain(OTHER_BODY);
    const logged = JSON.stringify(fixture.logs);
    expect(logged).toContain('ingress.dedupe_unverifiable');
    expect(logged).toContain('"bodyVerified":false');
    expect(logged).not.toContain(OTHER_BODY);
    expect(logged).not.toContain('same content');
    expect(logged).not.toContain('content match');
    expect(logged).not.toContain('confirmed');
  });

  it('does not reopen an expired or rejected event', async () => {
    const fixture = openFixture();
    const id = persona(6);
    seedPersona(fixture.store, id);
    const repos = createRepositories(fixture.store);
    const expiredId = eventId(7);
    const rejectedId = eventId(8);
    repos.events.insert({
      id: expiredId,
      personaId: id,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-expired',
      status: 'accepted',
      receivedAt: 1,
      updatedAt: 1,
    });
    repos.events.updateStatus({
      id: expiredId,
      status: 'expired',
      statusReason: 'ttl_expired',
      attentionOutcome: null,
      updatedAt: 2,
    });
    repos.events.insert({
      id: rejectedId,
      personaId: id,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-rejected',
      status: 'received',
      receivedAt: 1,
      updatedAt: 1,
    });
    repos.events.updateStatus({
      id: rejectedId,
      status: 'rejected',
      statusReason: 'auth_failed',
      attentionOutcome: null,
      updatedAt: 3,
    });
    const bus = ingress(fixture);

    const expired = await bus.acceptStimulus(envelope(id, 'mc-expired'));
    const rejected = await bus.acceptStimulus(envelope(id, 'mc-rejected'));

    expect(expired).toMatchObject({
      outcome: 'duplicate',
      eventId: expiredId,
      status: 'expired',
      bodyVerified: false,
    });
    expect(rejected).toMatchObject({
      outcome: 'duplicate',
      eventId: rejectedId,
      status: 'rejected',
      bodyVerified: false,
    });
    expect(repos.events.getById(expiredId)?.status).toBe('expired');
    expect(repos.events.getById(rejectedId)?.status).toBe('rejected');
    expect(bus.metrics()[DEDUPE_BODY_UNVERIFIABLE_METRIC]).toBe(2);
    expect(bus.readBuffered(id, expiredId)).toBeNull();
  });

  it('converges when the dedupe key hits the unique index after the snapshot missed it', async () => {
    const fixture = openFixture();
    const id = persona(9);
    seedPersona(fixture.store, id);
    const winner = eventId(10);
    let persistCalls = 0;
    const other = openStore({ file: join(fixture.dir, 'soul.db') });
    try {
      const bus = ingress(fixture, {
        duringRead: () => {
          createRepositories(other).events.insert({
            id: winner,
            personaId: id,
            source: SOURCE,
            adapterId: ADAPTER,
            adapterEventRef: 'mc-race',
            status: 'accepted',
            receivedAt: 4,
            updatedAt: 4,
          });
        },
        beforePersist: () => {
          persistCalls += 1;
        },
      });

      const result = await bus.acceptStimulus({
        stimulus: {
          ...(envelope(id, 'mc-race').stimulus as object),
          payload: { kind: 'mc.world', version: 1, text: OTHER_BODY },
        },
      });

      expect(persistCalls).toBe(1);
      expect(result).toMatchObject({
        outcome: 'duplicate',
        eventId: winner,
        status: 'accepted',
        bodyVerified: false,
      });
      expect(createRepositories(fixture.store).events.getById(winner)?.status).toBe('accepted');
      expect(
        createRepositories(fixture.store).events.listByPersonaStatus({
          personaId: id,
          status: 'accepted',
        }),
      ).toHaveLength(1);
      expect(bus.readBuffered(id, winner)).toBeNull();
      expect(dump(fixture.store)).not.toContain(OTHER_BODY);
    } finally {
      other.close();
    }
  });
});

describe('ingress — sessions', () => {
  it('reuses an open session and opens a new one after close', async () => {
    const fixture = openFixture();
    const id = persona(11);
    seedPersona(fixture.store, id);
    const bus = ingress(fixture);
    const first = await bus.acceptStimulus({
      ...envelope(id, 'mc-s1'),
      externalSessionRef: 'dsh:abc123',
    });
    const second = await bus.acceptStimulus({
      ...envelope(id, 'mc-s2'),
      externalSessionRef: 'dsh:abc123',
    });

    expect(first.outcome).toBe('accepted');
    expect(second.outcome).toBe('accepted');
    if (first.outcome !== 'accepted' || second.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    expect(isSessionId(first.sessionId)).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);

    const repos = createRepositories(fixture.store);
    expect(
      repos.sessions.close({
        id: first.sessionId as NonNullable<typeof first.sessionId>,
        closedAt: 50,
      }),
    ).toBe(true);
    const third = await bus.acceptStimulus({
      ...envelope(id, 'mc-s3'),
      externalSessionRef: 'dsh:abc123',
    });
    expect(third.outcome).toBe('accepted');
    if (third.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    expect(third.sessionId).not.toBe(first.sessionId);
    expect(
      repos.sessions.getById(first.sessionId as NonNullable<typeof first.sessionId>),
    ).toMatchObject({
      closedAt: 50,
    });
    expect(
      repos.sessions.getById(third.sessionId as NonNullable<typeof third.sessionId>),
    ).toMatchObject({
      closedAt: null,
      externalId: 'dsh:abc123',
    });
  });

  it('keeps session windows apart across personas and adapters', async () => {
    const fixture = openFixture();
    const left = persona(12);
    const right = persona(13);
    seedPersona(fixture.store, left);
    seedPersona(fixture.store, right, 'Other');
    const bus = ingress(fixture);
    const a = await bus.acceptStimulus({
      ...envelope(left, 'mc-a'),
      externalSessionRef: 'dsh:shared',
    });
    const b = await bus.acceptStimulus({
      stimulus: {
        schema: STIMULUS_INPUT_VERSION,
        personaId: right,
        adapterId: 'minecraft',
        source: 'minecraft.chat',
        adapterEventRef: 'mc-b',
        requestNonce: 'NQ7xK2mR9tVb4Wc9',
        payload: { kind: 'mc.world', version: 1 },
      },
      externalSessionRef: 'dsh:shared',
    });
    const c = await bus.acceptStimulus({
      stimulus: {
        schema: STIMULUS_INPUT_VERSION,
        personaId: left,
        adapterId: 'qq',
        source: 'qq.group',
        adapterEventRef: 'qq-c',
        requestNonce: 'NQ7xK2mR9tVb4W10',
        payload: { kind: 'qq.message', version: 1 },
      },
      externalSessionRef: 'dsh:shared',
    });

    expect(a.outcome).toBe('accepted');
    expect(b.outcome).toBe('accepted');
    expect(c.outcome).toBe('accepted');
    if (a.outcome !== 'accepted' || b.outcome !== 'accepted' || c.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    expect(new Set([a.sessionId, b.sessionId, c.sessionId]).size).toBe(3);
  });
});

describe('ingress — buffer, capacity, and ttl', () => {
  it('keeps a canary in memory until TTL and never writes it to the database or logs', async () => {
    const fixture = openFixture();
    const id = persona(14);
    seedPersona(fixture.store, id);
    fixture.time = 1_000;
    const bus = ingress(fixture, { config: { queueCapacity: 2, bufferTtlMs: 500 } });

    const accepted = await bus.acceptStimulus({
      stimulus: {
        ...(envelope(id, 'mc-canary').stimulus as object),
        payload: { kind: 'mc.world', version: 1, text: CANARY },
      },
    });
    expect(accepted.outcome).toBe('accepted');
    if (accepted.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    expect(bus.readBuffered(id, accepted.eventId)?.payload).toMatchObject({ text: CANARY });
    expect(dump(fixture.store)).not.toContain(CANARY);
    expect(JSON.stringify(fixture.logs)).not.toContain(CANARY);

    fixture.time = 1_499;
    expect((await bus.evictExpired()).length).toBe(0);
    expect(bus.readBuffered(id, accepted.eventId)?.payload).toMatchObject({ text: CANARY });

    fixture.time = 1_500;
    const expired = await bus.evictExpired();
    expect(expired).toEqual([{ eventId: accepted.eventId, personaId: id, reason: 'ttl_expired' }]);
    expect(bus.readBuffered(id, accepted.eventId)).toBeNull();
    expect(createRepositories(fixture.store).events.getById(accepted.eventId)).toMatchObject({
      status: 'expired',
      statusReason: 'ttl_expired',
      archiveState: 'none',
    });
    expect(dump(fixture.store)).not.toContain(CANARY);
    expect(JSON.stringify(fixture.logs)).not.toContain(CANARY);
    expect(fixture.scheduler.active()).toBe(0);
  });

  it('does not let TTL overwrite a terminal row, and drops the body anyway', async () => {
    const fixture = openFixture();
    const id = persona(15);
    seedPersona(fixture.store, id);
    fixture.time = 2_000;
    const bus = ingress(fixture, { config: { queueCapacity: 2, bufferTtlMs: 100 } });
    const accepted = await bus.acceptStimulus({
      stimulus: {
        ...(envelope(id, 'mc-terminal').stimulus as object),
        payload: { kind: 'mc.world', version: 1, text: CANARY },
      },
    });
    if (accepted.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    createRepositories(fixture.store).events.updateStatus({
      id: accepted.eventId,
      status: 'rejected',
      statusReason: 'processing_failed',
      attentionOutcome: null,
      updatedAt: 2_010,
    });

    fixture.time = 2_200;
    expect(await bus.evictExpired()).toEqual([]);
    expect(bus.readBuffered(id, accepted.eventId)).toBeNull();
    expect(createRepositories(fixture.store).events.getById(accepted.eventId)).toMatchObject({
      status: 'rejected',
      statusReason: 'processing_failed',
      updatedAt: 2_010,
    });
    expect(dump(fixture.store)).not.toContain(CANARY);
  });

  it('refuses overflow as expired queue_overflow and does not pretend success', async () => {
    const fixture = openFixture();
    const id = persona(16);
    seedPersona(fixture.store, id);
    const bus = ingress(fixture, { config: { queueCapacity: 1, bufferTtlMs: 5_000 } });
    const first = await bus.acceptStimulus(envelope(id, 'mc-one'));
    const overflow = await bus.acceptStimulus({
      stimulus: {
        ...(envelope(id, 'mc-two').stimulus as object),
        payload: { kind: 'mc.world', version: 1, text: CANARY },
      },
    });

    expect(first.outcome).toBe('accepted');
    expect(overflow).toMatchObject({
      outcome: 'refused',
      status: 'expired',
      reason: 'queue_overflow',
    });
    if (overflow.outcome !== 'refused' || first.outcome !== 'accepted') {
      throw new Error('unexpected outcome');
    }
    expect(createRepositories(fixture.store).events.getById(overflow.eventId)).toMatchObject({
      status: 'expired',
      statusReason: 'queue_overflow',
      archiveState: 'none',
      summary: null,
    });
    expect(bus.readBuffered(id, overflow.eventId)).toBeNull();
    expect(bus.readBuffered(id, first.eventId)).not.toBeNull();
    expect(dump(fixture.store)).not.toContain(CANARY);

    const again = await bus.acceptStimulus(envelope(id, 'mc-two'));
    expect(again).toMatchObject({
      outcome: 'duplicate',
      eventId: overflow.eventId,
      status: 'expired',
      bodyVerified: false,
    });
    expect(createRepositories(fixture.store).events.getById(overflow.eventId)?.status).toBe(
      'expired',
    );
  });

  it('isolates queues and buffers by persona and by source', async () => {
    const fixture = openFixture();
    const left = persona(17);
    const right = persona(18);
    seedPersona(fixture.store, left);
    seedPersona(fixture.store, right, 'Right');
    const bus = ingress(fixture, {
      config: {
        queueCapacity: 1,
        bufferTtlMs: 5_000,
        channels: { 'qq.group': { queueCapacity: 2, bufferTtlMs: 5_000 } },
      },
    });
    const kept = await bus.acceptStimulus({
      stimulus: {
        ...(envelope(left, 'mc-left').stimulus as object),
        payload: { kind: 'mc.world', version: 1, text: CANARY },
      },
    });
    const blocked = await bus.acceptStimulus(envelope(left, 'mc-left-2'));
    const otherPersona = await bus.acceptStimulus(envelope(right, 'mc-right'));
    const otherSource = await bus.acceptStimulus({
      stimulus: {
        schema: STIMULUS_INPUT_VERSION,
        personaId: left,
        adapterId: 'qq',
        source: 'qq.group',
        adapterEventRef: 'qq-1',
        requestNonce: 'NQ7xK2mR9tVb4Wc8',
        payload: { kind: 'qq.message', version: 1 },
      },
    });

    expect(blocked.outcome).toBe('refused');
    expect(otherPersona.outcome).toBe('accepted');
    expect(otherSource.outcome).toBe('accepted');
    if (kept.outcome !== 'accepted' || otherPersona.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    expect(bus.readBuffered(right, kept.eventId)).toBeNull();
    expect(bus.readBuffered(left, kept.eventId)?.payload).toMatchObject({ text: CANARY });
    expect(bus.listQueued(right).map((item) => item.eventId)).toEqual([otherPersona.eventId]);
    expect(bus.listQueued(left).some((item) => item.eventId === otherPersona.eventId)).toBe(false);
  });

  it('orders a persona queue by receivedAt and then eventId', async () => {
    const fixture = openFixture();
    const id = persona(19);
    seedPersona(fixture.store, id);
    let tick = 0;
    const bus = ingress(fixture, {
      now: () => {
        tick += 1;
        return tick === 1 ? 100 : 50;
      },
      randomBytes: (() => {
        const draws = [fill(1), fill(9), fill(2)];
        let index = 0;
        return () => draws[index++] ?? fill(3);
      })(),
    });
    const later = await bus.acceptStimulus(envelope(id, 'mc-later'));
    const earlier = await bus.acceptStimulus(envelope(id, 'mc-earlier'));
    const queued = bus.listQueued(id);

    expect(later.outcome).toBe('accepted');
    expect(earlier.outcome).toBe('accepted');
    expect(queued.map((item) => item.receivedAt)).toEqual([50, 100]);
    expect(queued.map((item) => item.eventId)).toEqual([earlier.eventId, later.eventId]);
    expect(queued.every((item) => !('payload' in item))).toBe(true);
  });

  it('fires the injected timer and cancels it on close', async () => {
    const fixture = openFixture();
    const id = persona(20);
    seedPersona(fixture.store, id);
    fixture.time = 10;
    const bus = ingress(fixture, { config: { queueCapacity: 2, bufferTtlMs: 40 } });
    const accepted = await bus.acceptStimulus(envelope(id, 'mc-timer'));
    expect(fixture.scheduler.active()).toBe(1);
    expect(fixture.scheduler.timers[0]?.delay).toBe(40);

    fixture.time = 50;
    fixture.scheduler.timers[0]?.fire();
    await waitFor(() => bus.readBuffered(id, eventOf(accepted)) === null);
    expect(createRepositories(fixture.store).events.getById(eventOf(accepted))?.statusReason).toBe(
      'ttl_expired',
    );

    const again = await bus.acceptStimulus(envelope(id, 'mc-timer-2'));
    expect(fixture.scheduler.active()).toBe(1);
    bus.close();
    expect(fixture.scheduler.active()).toBe(0);
    fixture.scheduler.timers.at(-1)?.fire();
    expect(createRepositories(fixture.store).events.getById(eventOf(again))?.status).toBe(
      'accepted',
    );
    await expect(bus.acceptStimulus(envelope(id, 'mc-after-close'))).rejects.toMatchObject({
      code: 'closed',
    });
  });

  it('does not keep a caller-mutated payload', async () => {
    const fixture = openFixture();
    const id = persona(21);
    seedPersona(fixture.store, id);
    const bus = ingress(fixture);
    const payload = { kind: 'mc.world', version: 1, text: CANARY };
    const accepted = await bus.acceptStimulus({
      stimulus: { ...(envelope(id, 'mc-clone').stimulus as object), payload },
    });
    payload.text = 'mutated';
    if (accepted.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    expect(bus.readBuffered(id, accepted.eventId)?.payload).toMatchObject({ text: CANARY });
    const peeked = bus.readBuffered(id, accepted.eventId);
    if (peeked === null) {
      throw new Error('expected a buffer hit');
    }
    (peeked.payload as unknown as { text: string }).text = 'mutated-again';
    expect(bus.readBuffered(id, accepted.eventId)?.payload).toMatchObject({ text: CANARY });
  });
});

describe('ingress — isolation and robustness', () => {
  it('serializes one persona and lets another persona proceed', async () => {
    const fixture = openFixture();
    const left = persona(22);
    const right = persona(23);
    seedPersona(fixture.store, left);
    seedPersona(fixture.store, right, 'Right');
    let releaseLeft: () => void = () => {};
    const leftGate = new Promise<void>((resolve) => {
      releaseLeft = resolve;
    });
    let leftEntered = false;
    let rightEntered = false;
    const bus = ingress(fixture, {
      beforePersist: (view) => {
        if (view.personaId === right) {
          rightEntered = true;
          return undefined;
        }
        leftEntered = true;
        return leftGate;
      },
    });

    const pendingLeft = bus.acceptStimulus(envelope(left, 'mc-left'));
    const pendingRight = bus.acceptStimulus(envelope(right, 'mc-right'));
    await waitFor(() => leftEntered);
    const rightResult = await pendingRight;
    expect(rightResult.outcome).toBe('accepted');
    expect(rightEntered).toBe(true);
    expect(leftEntered).toBe(true);
    releaseLeft();
    expect((await pendingLeft).outcome).toBe('accepted');

    let started = 0;
    let releaseSerial: () => void = () => {};
    const serialGate = new Promise<void>((resolve) => {
      releaseSerial = resolve;
    });
    const serial = ingress(fixture, {
      beforePersist: () => {
        started += 1;
        if (started === 1) {
          return serialGate;
        }
        return undefined;
      },
    });
    const first = serial.acceptStimulus(envelope(left, 'mc-serial-1'));
    await waitFor(() => started === 1);
    const second = serial.acceptStimulus(envelope(left, 'mc-serial-2'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(1);
    releaseSerial();
    expect((await first).outcome).toBe('accepted');
    expect((await second).outcome).toBe('accepted');
    expect(started).toBe(2);
  });

  it('retries when the first event id is already occupied', async () => {
    const fixture = openFixture();
    const id = persona(24);
    seedPersona(fixture.store, id);
    const taken = allocateEventId({ now: () => 5_000_000, randomBytes: () => fill(1) });
    createRepositories(fixture.store).events.insert({
      id: taken,
      personaId: id,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-taken',
      status: 'accepted',
      receivedAt: 1,
      updatedAt: 1,
    });
    let draw = 0;
    const bus = ingress(fixture, {
      randomBytes: () => {
        draw += 1;
        return fill(draw);
      },
    });

    const created = await bus.acceptStimulus(envelope(id, 'mc-fresh'));
    expect(created.outcome).toBe('accepted');
    expect(created.eventId).not.toBe(taken);
    expect(createRepositories(fixture.store).events.getById(taken)?.adapterEventRef).toBe(
      'mc-taken',
    );
  });

  it('does not let a throwing logger hide a commit, a dedupe hit, or a schema error', async () => {
    const fixture = openFixture();
    const id = persona(25);
    seedPersona(fixture.store, id);
    const loud = ingress(fixture, { logger: throwingLogger('info') });
    const accepted = await loud.acceptStimulus(envelope(id, 'mc-log'));
    expect(accepted.outcome).toBe('accepted');
    expect(createRepositories(fixture.store).events.getById(eventOf(accepted))?.status).toBe(
      'accepted',
    );

    const again = await loud.acceptStimulus(envelope(id, 'mc-log'));
    expect(again).toMatchObject({
      outcome: 'duplicate',
      eventId: accepted.eventId,
      bodyVerified: false,
    });

    const strict = ingress(fixture, { logger: throwingLogger('warn') });
    await expect(
      promiseOf(() => strict.acceptStimulus(envelope(id, 'mc-bad', { receivedAt: 5 }))),
    ).rejects.toMatchObject({ name: 'RuntimeError', code: 'schema_invalid' });
  });

  it('rejects illegal configuration instead of running unbounded', () => {
    const fixture = openFixture();
    expect(() => ingress(fixture, { config: { queueCapacity: 0, bufferTtlMs: 1 } })).toThrow(
      RuntimeError,
    );
    expect(() =>
      ingress(fixture, {
        config: { queueCapacity: 1, bufferTtlMs: 1, personaAdmissionCapacity: 0 },
      }),
    ).toThrow(RuntimeError);
    expect(() =>
      createStimulusIngress({
        store: fixture.store,
        logger: fixture.logger,
        config: { queueCapacity: 1, bufferTtlMs: 1 } as StimulusIngressConfig,
      }),
    ).toThrow(RuntimeError);
    expect(() =>
      ingress(fixture, { config: { queueCapacity: 1.5, bufferTtlMs: 1 } as StimulusIngressConfig }),
    ).toThrow(RuntimeError);
    expect(() =>
      ingress(fixture, {
        config: {
          queueCapacity: 1,
          bufferTtlMs: 1,
          channels: { QQ: { queueCapacity: 1, bufferTtlMs: 1 } },
        },
      }),
    ).toThrow(RuntimeError);
    expect(() =>
      ingress(fixture, {
        config: {
          queueCapacity: 1,
          bufferTtlMs: 1,
          channels: { 'minecraft.chat': { queueCapacity: 1 } as StimulusIngressConfig },
        },
      }),
    ).toThrow(RuntimeError);
  });

  it('does not mention archive compare or pending writes in the ingress source', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/events/bus.ts', import.meta.url)),
      'utf8',
    );
    expect(source.includes('archive.compare')).toBe(false);
    expect(source.includes("archive_state = 'pending'")).toBe(false);
  });
});

describe('ingress — admission bounds and snapshot', () => {
  it('refuses further accepts before enqueue while one admission is still running', async () => {
    const fixture = openFixture();
    const id = persona(30);
    seedPersona(fixture.store, id);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const bus = ingress(fixture, {
      config: { queueCapacity: 1, bufferTtlMs: 60_000 },
      beforePersist: () => {
        entered += 1;
        return gate;
      },
    });
    const first = bus.acceptStimulus(envelope(id, 'mc-hold'));
    await waitFor(() => entered === 1);

    const flood = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        bus.acceptStimulus({
          stimulus: {
            ...(envelope(id, `mc-flood-${index}`).stimulus as object),
            payload: { kind: 'mc.world', version: 1, text: `${CANARY}-flood-${index}` },
          },
        }),
      ),
    );

    expect(entered).toBe(1);
    expect(flood).toHaveLength(40);
    expect(flood.every((result) => result.outcome === 'backpressure')).toBe(true);
    expect(
      createRepositories(fixture.store).events.listByPersonaStatus({
        personaId: id,
        status: 'accepted',
      }),
    ).toEqual([]);
    expect(dump(fixture.store).includes(`${CANARY}-flood`)).toBe(false);

    release();
    const held = await first;
    expect(held.outcome).toBe('accepted');
    expect(
      createRepositories(fixture.store).events.listByPersonaStatus({
        personaId: id,
        status: 'accepted',
      }),
    ).toHaveLength(1);
    expect(dump(fixture.store).includes(`${CANARY}-flood`)).toBe(false);
  });

  it('returns null from readBuffered once the clock passes TTL even if the timer has not fired', async () => {
    const fixture = openFixture();
    const id = persona(31);
    seedPersona(fixture.store, id);
    fixture.time = 1_000;
    const bus = ingress(fixture, { config: { queueCapacity: 2, bufferTtlMs: 100 } });
    const accepted = await bus.acceptStimulus({
      stimulus: {
        ...(envelope(id, 'mc-late-read').stimulus as object),
        payload: { kind: 'mc.world', version: 1, text: CANARY },
      },
    });
    if (accepted.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    expect(bus.readBuffered(id, accepted.eventId)?.payload).toMatchObject({ text: CANARY });
    expect(fixture.scheduler.timers.some((timer) => !timer.fired && !timer.cancelled)).toBe(true);

    fixture.time = 1_100;
    expect(bus.readBuffered(id, accepted.eventId)).toBeNull();
    expect(bus.readBuffered(id, accepted.eventId)).toBeNull();
    expect(dump(fixture.store)).not.toContain(CANARY);
  });

  it('drops the body when the TTL database update fails and retries the metadata later', async () => {
    const fixture = openFixture();
    const id = persona(32);
    seedPersona(fixture.store, id);
    fixture.time = 2_000;
    let failures = 1;
    const bus = ingress(fixture, {
      config: { queueCapacity: 2, bufferTtlMs: 50 },
      beforeExpire: () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('sqlite-down');
        }
      },
    });
    const accepted = await bus.acceptStimulus({
      stimulus: {
        ...(envelope(id, 'mc-db-down').stimulus as object),
        payload: { kind: 'mc.world', version: 1, text: CANARY },
      },
    });
    if (accepted.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    fixture.time = 2_050;
    expect(await bus.evictExpired()).toEqual([]);
    expect(bus.readBuffered(id, accepted.eventId)).toBeNull();
    expect(JSON.stringify(fixture.logs)).toContain('ingress.ttl_persist_failed');
    expect(dump(fixture.store)).not.toContain(CANARY);
    expect(createRepositories(fixture.store).events.getById(accepted.eventId)).toMatchObject({
      status: 'accepted',
      statusReason: null,
    });

    const repaired = await bus.evictExpired();
    expect(repaired).toEqual([{ eventId: accepted.eventId, personaId: id, reason: 'ttl_expired' }]);
    expect(createRepositories(fixture.store).events.getById(accepted.eventId)).toMatchObject({
      status: 'expired',
      statusReason: 'ttl_expired',
    });
    expect(bus.readBuffered(id, accepted.eventId)).toBeNull();
  });

  it('does not keep a body when the scheduler refuses to register a timer', async () => {
    const fixture = openFixture();
    const id = persona(33);
    seedPersona(fixture.store, id);
    const bus = ingress(fixture, {
      timers: {
        schedule() {
          throw new Error('schedule-failed');
        },
      },
    });
    const accepted = await bus.acceptStimulus({
      stimulus: {
        ...(envelope(id, 'mc-no-timer').stimulus as object),
        payload: { kind: 'mc.world', version: 1, text: CANARY },
      },
    });
    expect(accepted).toMatchObject({
      outcome: 'rejected',
      status: 'rejected',
      reason: 'processing_failed',
    });
    if (accepted.outcome !== 'rejected') {
      throw new Error('expected the lost buffer to be closed before ACK');
    }
    expect(bus.readBuffered(id, accepted.eventId)).toBeNull();
    expect(bus.listQueued(id)).toEqual([]);
    expect(JSON.stringify(fixture.logs)).toContain('ingress.buffer_failed');
    expect(dump(fixture.store)).not.toContain(CANARY);
    expect(createRepositories(fixture.store).events.getById(accepted.eventId)).toMatchObject({
      status: 'rejected',
      statusReason: 'processing_failed',
    });
  });

  it('keeps the validated snapshot after the caller mutates the original object', async () => {
    const fixture = openFixture();
    const id = persona(34);
    const other = persona(35);
    seedPersona(fixture.store, id);
    seedPersona(fixture.store, other, 'Other');
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const bus = ingress(fixture, {
      config: { queueCapacity: 2, bufferTtlMs: 60_000 },
      beforePersist: () => {
        entered = true;
        return gate;
      },
    });
    const payload = { kind: 'mc.world', version: 1, text: CANARY };
    const stimulus: Record<string, unknown> = {
      schema: STIMULUS_INPUT_VERSION,
      personaId: id,
      adapterId: 'minecraft',
      source: 'minecraft.chat',
      adapterEventRef: 'mc-snap',
      requestNonce: 'NQ7xK2mR9tVb4Wc8',
      payload,
    };
    const pending = bus.acceptStimulus({ stimulus });
    await waitFor(() => entered);
    stimulus['personaId'] = other;
    payload.text = 'tampered-body';
    release();
    const result = await pending;

    expect(result).toMatchObject({ outcome: 'accepted', eventId: expect.any(String) });
    if (result.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    expect(createRepositories(fixture.store).events.getById(result.eventId)).toMatchObject({
      personaId: id,
      adapterEventRef: 'mc-snap',
    });
    expect(
      createRepositories(fixture.store).events.listByPersonaStatus({
        personaId: other,
        status: 'accepted',
      }),
    ).toEqual([]);
    expect(bus.readBuffered(id, result.eventId)?.payload).toMatchObject({ text: CANARY });
    expect(dump(fixture.store)).not.toContain('tampered-body');
  });

  it('stamps receivedAt at the gate, not when a delayed admission finally runs', async () => {
    const fixture = openFixture();
    const id = persona(36);
    seedPersona(fixture.store, id);
    fixture.time = 1_000;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const bus = ingress(fixture, {
      config: { queueCapacity: 2, bufferTtlMs: 50_000_000 },
      beforePersist: () => {
        entered = true;
        return gate;
      },
    });
    const pending = bus.acceptStimulus(envelope(id, 'mc-stamp'));
    await waitFor(() => entered);
    fixture.time = 9_000_000;
    release();
    const result = await pending;

    expect(result).toMatchObject({ outcome: 'accepted', receivedAt: 1_000 });
    if (result.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    expect(createRepositories(fixture.store).events.getById(result.eventId)).toMatchObject({
      receivedAt: 1_000,
      status: 'accepted',
    });
  });
});

describe('ingress — review bounds', () => {
  it('reports expired when the receipt TTL elapses before ACK', async () => {
    const fixture = openFixture();
    const id = persona(40);
    seedPersona(fixture.store, id);
    fixture.time = 1_000;
    const bus = ingress(fixture, {
      config: { queueCapacity: 2, bufferTtlMs: 100 },
      beforePersist: () => {
        fixture.time = 5_000;
      },
    });
    const result = await bus.acceptStimulus({
      stimulus: {
        ...(envelope(id, 'mc-aged').stimulus as object),
        payload: { kind: 'mc.world', version: 1, text: CANARY },
      },
    });

    expect(result).toMatchObject({
      outcome: 'expired',
      status: 'expired',
      reason: 'ttl_expired',
      receivedAt: 1_000,
    });
    if (result.outcome !== 'expired') {
      throw new Error('expected expired');
    }
    expect(createRepositories(fixture.store).events.getById(result.eventId)).toMatchObject({
      status: 'expired',
      statusReason: 'ttl_expired',
      receivedAt: 1_000,
    });
    expect(bus.readBuffered(id, result.eventId)).toBeNull();
    expect(dump(fixture.store)).not.toContain(CANARY);
  });

  it('caps in-flight admissions for one persona across sources', async () => {
    const fixture = openFixture();
    const id = persona(41);
    seedPersona(fixture.store, id);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const bus = ingress(fixture, {
      config: { queueCapacity: 4, bufferTtlMs: 60_000, personaAdmissionCapacity: 1 },
      beforePersist: () => {
        entered += 1;
        return gate;
      },
    });
    const first = bus.acceptStimulus(envelope(id, 'mc-hold'));
    await waitFor(() => entered === 1);

    const flood = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        bus.acceptStimulus({
          stimulus: {
            schema: STIMULUS_INPUT_VERSION,
            personaId: id,
            adapterId: 'minecraft',
            source: `src.chan${index}`,
            adapterEventRef: `ref-${index}`,
            requestNonce: 'NQ7xK2mR9tVb4Wc8',
            payload: { kind: 'mc.world', version: 1, text: `${CANARY}-src-${index}` },
          },
        }),
      ),
    );

    expect(entered).toBe(1);
    expect(flood.every((result) => result.outcome === 'backpressure')).toBe(true);
    expect(dump(fixture.store).includes(`${CANARY}-src`)).toBe(false);
    release();
    expect((await first).outcome).toBe('accepted');
    expect(
      createRepositories(fixture.store).events.listByPersonaStatus({
        personaId: id,
        status: 'accepted',
      }),
    ).toHaveLength(1);
  });

  it('keeps a TTL retry when the clock throws and does not emit an unhandled rejection', async () => {
    const fixture = openFixture();
    const id = persona(42);
    seedPersona(fixture.store, id);
    fixture.time = 3_000;
    let failures = 1;
    let clockDown = false;
    const rejections: unknown[] = [];
    const onRejection = (error: unknown): void => {
      rejections.push(error);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const bus = ingress(fixture, {
        config: { queueCapacity: 2, bufferTtlMs: 40 },
        now: () => {
          if (clockDown) {
            throw new Error('clock-down');
          }
          return fixture.time;
        },
        beforeExpire: () => {
          if (failures > 0) {
            failures -= 1;
            throw new Error('sqlite-down');
          }
        },
      });
      const accepted = await bus.acceptStimulus(envelope(id, 'mc-retry'));
      if (accepted.outcome !== 'accepted') {
        throw new Error('expected accepted');
      }
      fixture.time = 3_040;
      expect(await bus.evictExpired()).toEqual([]);
      expect(createRepositories(fixture.store).events.getById(accepted.eventId)?.status).toBe(
        'accepted',
      );

      const retry = fixture.scheduler.timers.find((timer) => timer.delay === 0 && !timer.fired);
      expect(retry).toBeDefined();
      clockDown = true;
      retry?.fire();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections).toEqual([]);
      expect(createRepositories(fixture.store).events.getById(accepted.eventId)?.status).toBe(
        'accepted',
      );

      clockDown = false;
      const repaired = await bus.evictExpired();
      expect(repaired).toEqual([
        { eventId: accepted.eventId, personaId: id, reason: 'ttl_expired' },
      ]);
      expect(createRepositories(fixture.store).events.getById(accepted.eventId)).toMatchObject({
        status: 'expired',
        statusReason: 'ttl_expired',
      });
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('ingress — post-commit isolation', () => {
  it('returns the committed row when the clock fails after the envelope is stored', async () => {
    const fixture = openFixture();
    const id = persona(43);
    seedPersona(fixture.store, id);
    fixture.time = 4_000;
    let trap = false;
    const bus = ingress(fixture, {
      config: { queueCapacity: 2, bufferTtlMs: 60_000 },
      now: () => {
        if (trap) {
          trap = false;
          throw new Error('clock-after-commit');
        }
        return fixture.time;
      },
      beforePersist: () => {
        trap = true;
      },
    });
    const result = await bus.acceptStimulus({
      stimulus: {
        ...(envelope(id, 'mc-clock').stimulus as object),
        payload: { kind: 'mc.world', version: 1, text: CANARY },
      },
    });

    expect(result).toMatchObject({ outcome: 'accepted', status: 'accepted', receivedAt: 4_000 });
    if (result.outcome !== 'accepted') {
      throw new Error('expected the committed accept to be returned');
    }
    expect(bus.readBuffered(id, result.eventId)).toBeNull();
    expect(dump(fixture.store)).not.toContain(CANARY);
    expect(createRepositories(fixture.store).events.getById(result.eventId)).toMatchObject({
      status: 'accepted',
      statusReason: null,
    });
    expect(JSON.stringify(fixture.logs)).toContain('ingress.post_commit_failed');

    const repaired = await bus.evictExpired();
    expect(repaired).toEqual([]);
    expect(createRepositories(fixture.store).events.getById(result.eventId)).toMatchObject({
      status: 'rejected',
      statusReason: 'processing_failed',
    });
  });

  it('drops the body when a later timer registration throws and closes the event', async () => {
    const fixture = openFixture();
    const id = persona(44);
    seedPersona(fixture.store, id);
    fixture.time = 1_000;
    let schedules = 0;
    const timers: { delay: number; fire: () => void }[] = [];
    const rejections: unknown[] = [];
    const onRejection = (error: unknown): void => {
      rejections.push(error);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const bus = ingress(fixture, {
        config: { queueCapacity: 2, bufferTtlMs: 60_000 },
        timers: {
          schedule(delayMs, fire) {
            schedules += 1;
            if (schedules > 1) {
              throw new Error('rearm-failed');
            }
            timers.push({ delay: delayMs, fire });
            return { cancel() {} };
          },
        },
      });
      const accepted = await bus.acceptStimulus({
        stimulus: {
          ...(envelope(id, 'mc-rearm').stimulus as object),
          payload: { kind: 'mc.world', version: 1, text: CANARY },
        },
      });
      if (accepted.outcome !== 'accepted') {
        throw new Error('expected accepted');
      }
      expect(bus.readBuffered(id, accepted.eventId)?.payload).toMatchObject({ text: CANARY });
      expect(() => timers[0]?.fire()).not.toThrow();
      await waitFor(
        () =>
          createRepositories(fixture.store).events.getById(accepted.eventId)?.status === 'rejected',
      );
      expect(rejections).toEqual([]);
      expect(bus.readBuffered(id, accepted.eventId)).toBeNull();
      expect(dump(fixture.store)).not.toContain(CANARY);
      expect(createRepositories(fixture.store).events.getById(accepted.eventId)).toMatchObject({
        status: 'rejected',
        statusReason: 'processing_failed',
      });
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('default scheduler', () => {
  it('cancel stops the timer from firing', async () => {
    const scheduler = createDefaultIngressScheduler();
    let fired = false;
    const timer = scheduler.schedule(60_000, () => {
      fired = true;
    });
    timer.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fired).toBe(false);
  });
});
