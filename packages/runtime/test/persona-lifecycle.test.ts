/**
 * Persona lifecycle against a real migrated SQLite file.
 *
 * The suite drives `@soul-harness/runtime` only for the behavior under test.
 * Persistence repositories are used to seed states the lifecycle itself will
 * not linger in (STARTING, STOPPING, FAILED) and to prove the runtime package
 * did not need its own SQL.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BootId, PersonaId } from '@soul-harness/contracts';
import { isPersonaId } from '@soul-harness/contracts';
import {
  createRepositories,
  migrate,
  openStore,
  withWrite,
  type Store,
} from '@soul-harness/persistence';
import type { PersonaState } from '@soul-harness/persistence';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ID_ENTROPY_BYTES,
  PERSONA_DISPLAY_NAME_MAX_LENGTH,
  RuntimeError,
  allocatePersonaId,
  createPersonaLifecycle,
  isRuntimeError,
} from '../src/index.js';
import type {
  PersonaCommitView,
  PersonaLifecycle,
  PersonaSnapshot,
  RuntimeLogFields,
  RuntimeLogger,
} from '../src/index.js';

const BOOT_A = 'boot-sh008b-a' as BootId;
const BOOT_B = 'boot-sh008b-b' as BootId;
const CANARY = 'CanaryNameXiang';

interface CapturedLog {
  readonly level: string;
  readonly event: string;
  readonly fields?: RuntimeLogFields;
}

interface Fixture {
  readonly store: Store;
  readonly dir: string;
  readonly logs: CapturedLog[];
  readonly logger: RuntimeLogger;
  time: number;
}

const fixtures: Fixture[] = [];

function remember(fixture: Fixture): Fixture {
  fixtures.push(fixture);
  return fixture;
}

function openFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'sh-persona-'));
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
    time: 5_000,
  });
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop() as Fixture;
    fixture.store.close();
    rmSync(fixture.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

function lifecycle(
  fixture: Fixture,
  bootId: BootId = BOOT_A,
  extra: {
    readonly beforeCommit?: (persona: PersonaCommitView) => void | Promise<void>;
    readonly duringRead?: () => void;
    readonly randomBytes?: (size: number) => Uint8Array;
    readonly logger?: RuntimeLogger;
  } = {},
): PersonaLifecycle {
  return createPersonaLifecycle({
    store: fixture.store,
    logger: extra.logger ?? fixture.logger,
    bootId,
    now: () => {
      fixture.time += 1;
      return fixture.time;
    },
    ...(extra.randomBytes === undefined ? {} : { randomBytes: extra.randomBytes }),
    ...(extra.beforeCommit === undefined ? {} : { beforeCommit: extra.beforeCommit }),
    ...(extra.duringRead === undefined ? {} : { duringRead: extra.duringRead }),
  });
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

/** The call itself must return a promise. A synchronous throw is a failure. */
function promiseOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return run();
  } catch (error) {
    throw new Error('call threw synchronously', { cause: error });
  }
}

function assertNoCanary(fixture: Fixture): void {
  expect(JSON.stringify(fixture.logs).includes(CANARY)).toBe(false);
}

function reposOf(store: Store) {
  return createRepositories(store);
}

async function codeOf(run: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (isRuntimeError(error)) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected the call to throw');
}

function fill(value: number): Uint8Array {
  return new Uint8Array(ID_ENTROPY_BYTES).fill(value);
}

describe('persona lifecycle — create, query, restore', () => {
  it('allocates one id, mirrors runtime_state, and does not bump epoch', async () => {
    const fixture = openFixture();
    const life = lifecycle(fixture);
    const created = await life.createPersona({ displayName: CANARY });

    expect(isPersonaId(created.id)).toBe(true);
    expect(created).toMatchObject({
      displayName: CANARY,
      state: 'CREATED',
      version: 0,
      epoch: 1,
      bootId: null,
      runtimeState: { state: 'CREATED', epoch: 1, bootId: null },
    });
    expect(created.runtimeState?.updatedAt).toBe(created.updatedAt);

    const stored = reposOf(fixture.store);
    expect(stored.personas.getById(created.id)).toMatchObject({
      state: 'CREATED',
      version: 0,
      epoch: 1,
    });
    expect(stored.runtimeState.get(created.id)).toMatchObject({ state: 'CREATED', epoch: 1 });
    expect(stored.checkpoints.load(created.id)).toEqual({ status: 'absent' });
    expect(life.getPersona(created.id)?.id).toBe(created.id);
    expect(life.getPersona('psn_01JQ8Z3K5M7P9R2T4V6X8Z0ZZZ' as PersonaId)).toBeNull();
    assertNoCanary(fixture);
  });

  it('ignores a caller-supplied id and retries when the first candidate is taken', async () => {
    const fixture = openFixture();
    const now = () => 1_700_000_000_000;
    const taken = allocatePersonaId({ now, randomBytes: () => fill(1) });
    reposOf(fixture.store).personas.insert({
      id: taken,
      displayName: 'Occupied',
      state: 'CREATED',
      createdAt: 1,
      updatedAt: 1,
    });

    let index = 0;
    const chunks = [fill(1), fill(2)];
    const life = createPersonaLifecycle({
      store: fixture.store,
      logger: fixture.logger,
      bootId: BOOT_A,
      now,
      randomBytes: () => {
        const next = chunks[index];
        index += 1;
        if (next === undefined) {
          throw new Error('entropy exhausted');
        }
        return next;
      },
    });

    const created = await life.createPersona({
      displayName: 'Fresh',
      ...({ id: taken } as object),
    } as { displayName: string });
    expect(created.id).not.toBe(taken);
    expect(isPersonaId(created.id)).toBe(true);
    expect(life.listPersonas()).toHaveLength(2);
  });

  it('rejects a bad display name without inserting', async () => {
    const fixture = openFixture();
    const life = lifecycle(fixture);
    const samples = [
      '',
      '  padded',
      'padded  ',
      'has\nline',
      'a'.repeat(PERSONA_DISPLAY_NAME_MAX_LENGTH + 1),
    ];
    for (const displayName of samples) {
      expect(await codeOf(() => life.createPersona({ displayName }))).toBe('invalid_argument');
    }
    expect(life.listPersonas()).toEqual([]);
    const accepted = await life.createPersona({
      displayName: 'a'.repeat(PERSONA_DISPLAY_NAME_MAX_LENGTH),
    });
    expect(accepted.displayName).toHaveLength(PERSONA_DISPLAY_NAME_MAX_LENGTH);
  });

  it('lists and queries every page, ordered by id', async () => {
    const fixture = openFixture();
    const life = lifecycle(fixture);
    const total = 501;
    const ids: PersonaId[] = [];
    for (let index = 0; index < total; index += 1) {
      ids.push((await life.createPersona({ displayName: `P${String(index)}` })).id);
    }
    const listed = life.listPersonas();
    expect(listed).toHaveLength(total);
    const sorted = [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    expect(listed.map((row) => row.id)).toEqual(sorted);

    const running = reposOf(fixture.store).personas.commitLifecycle({
      id: ids[0] as PersonaId,
      expectedState: 'CREATED',
      expectedVersion: 0,
      nextState: 'STARTING',
      updatedAt: 9,
    });
    expect(running).not.toBeNull();
    expect(life.queryPersonas({ state: 'STARTING' })).toHaveLength(1);
    expect(life.queryPersonas({ state: 'CREATED' })).toHaveLength(total - 1);
    expect(life.queryPersonas({})).toHaveLength(total);
    expect(await codeOf(() => life.queryPersonas({ state: 'running' as PersonaState }))).toBe(
      'invalid_argument',
    );
  });

  it('restores the existing id and does not allocate a second persona', async () => {
    const fixture = openFixture();
    const first = lifecycle(fixture, BOOT_A);
    const created = await first.createPersona({ displayName: CANARY });
    await first.stopPersona(created.id);

    const restarted = createPersonaLifecycle({
      store: fixture.store,
      logger: fixture.logger,
      bootId: BOOT_B,
      randomBytes: () => {
        throw new Error('restore must not allocate');
      },
    });
    const restored = restarted.restorePersona(created.id);
    expect(restored.id).toBe(created.id);
    expect(restored.state).toBe('STOPPED');
    expect(restored.epoch).toBe(created.epoch);
    expect(restarted.listPersonas()).toHaveLength(1);

    const again = await restarted.startPersona(created.id);
    expect(again.id).toBe(created.id);
    expect(again.state).toBe('RUNNING');
    expect(again.bootId).toBe(BOOT_B);
    expect(again.epoch).toBe(1);
    expect(restarted.listPersonas()).toHaveLength(1);

    const other = await lifecycle(fixture, BOOT_B).createPersona({ displayName: 'Other' });
    expect(other.id).not.toBe(created.id);
    expect(restarted.restorePersona(created.id).id).toBe(created.id);
    expect(restarted.listPersonas()).toHaveLength(2);

    const missing = allocatePersonaId({ now: () => 2, randomBytes: () => fill(9) });
    expect(await codeOf(() => restarted.restorePersona(missing))).toBe('not_found');
    expect(await codeOf(() => restarted.restorePersona('not-a-persona' as PersonaId))).toBe(
      'invalid_argument',
    );
    expect(restarted.listPersonas()).toHaveLength(2);
    assertNoCanary(fixture);
  });
});

describe('persona lifecycle — legal and illegal transitions', () => {
  it('walks CREATED → RUNNING → SUSPENDED → RUNNING → STOPPED and keeps epoch', async () => {
    const fixture = openFixture();
    const seen: PersonaState[] = [];
    const life = lifecycle(fixture, BOOT_A, {
      beforeCommit: (view) => {
        seen.push(view.state);
      },
    });
    const created = await life.createPersona({ displayName: CANARY });
    withWrite(fixture.store, (tx) => {
      tx.prepare('UPDATE personas SET epoch = ? WHERE id = ?').run(7, created.id);
      tx.prepare('UPDATE runtime_state SET epoch = ? WHERE persona_id = ?').run(7, created.id);
    });
    reposOf(fixture.store).checkpoints.save({
      personaId: created.id,
      epoch: 7,
      refs: { cursor: 'sched:0:1' },
      updatedAt: 8,
    });

    const running = await life.startPersona(created.id);
    expect(seen).toEqual(['CREATED', 'STARTING']);
    expect(running).toMatchObject({
      state: 'RUNNING',
      version: 2,
      epoch: 7,
      bootId: BOOT_A,
      runtimeState: { state: 'RUNNING', epoch: 7, bootId: BOOT_A },
    });

    const suspended = await life.suspendPersona(created.id);
    expect(suspended).toMatchObject({
      state: 'SUSPENDED',
      version: 3,
      epoch: 7,
      bootId: BOOT_A,
    });

    const resumed = await lifecycle(fixture, BOOT_B).resumePersona(created.id);
    expect(resumed).toMatchObject({
      state: 'RUNNING',
      version: 4,
      epoch: 7,
      bootId: BOOT_B,
      runtimeState: { state: 'RUNNING', epoch: 7, bootId: BOOT_B },
    });

    const stopped = await life.stopPersona(created.id);
    expect(stopped).toMatchObject({
      state: 'STOPPED',
      version: 6,
      epoch: 7,
      bootId: BOOT_B,
      runtimeState: { state: 'STOPPED', epoch: 7, bootId: BOOT_B },
    });
    // The hook sees the state being left, and resume runs on a second lifecycle
    // that does not share this hook.
    expect(seen).toEqual(['CREATED', 'STARTING', 'RUNNING', 'RUNNING', 'STOPPING']);

    const loaded = reposOf(fixture.store).checkpoints.load(created.id);
    expect(loaded.status).toBe('present');
    if (loaded.status === 'present') {
      expect(loaded.stored.checkpoint.refs?.cursor).toBe('sched:0:1');
      expect(loaded.stored.checkpoint.epoch).toBe(7);
    }
    expect(reposOf(fixture.store).personas.getById(created.id)?.epoch).toBe(7);
    assertNoCanary(fixture);
  });

  it('stops from every state, and a second stop does not bump version', async () => {
    const fixture = openFixture();
    const life = lifecycle(fixture);
    const versions = new Map<PersonaState, number>();

    async function stoppedFrom(from: PersonaState): Promise<PersonaSnapshot> {
      const created = await life.createPersona({ displayName: `From${from}` });
      if (from !== 'CREATED') {
        const seeded = reposOf(fixture.store).personas.commitLifecycle({
          id: created.id,
          expectedState: 'CREATED',
          expectedVersion: 0,
          nextState: from,
          updatedAt: 20,
          ...(from === 'STARTING' ? { bootId: BOOT_A } : {}),
        });
        expect(seeded?.persona.state).toBe(from);
      }
      const stopped = await life.stopPersona(created.id);
      expect(stopped.state).toBe('STOPPED');
      expect(stopped.runtimeState?.state).toBe('STOPPED');
      expect(stopped.epoch).toBe(1);
      versions.set(from, stopped.version);
      const again = await life.stopPersona(created.id);
      expect(again.version).toBe(stopped.version);
      expect(again.state).toBe('STOPPED');
      return stopped;
    }

    await stoppedFrom('CREATED');
    await stoppedFrom('STARTING');
    await stoppedFrom('RUNNING');
    await stoppedFrom('SUSPENDED');
    await stoppedFrom('STOPPING');
    await stoppedFrom('STOPPED');
    await stoppedFrom('FAILED');

    expect(versions.get('CREATED')).toBe(2);
    expect(versions.get('STARTING')).toBe(3);
    expect(versions.get('STOPPING')).toBe(2);
    expect(versions.get('STOPPED')).toBe(1);
    expect(versions.get('FAILED')).toBe(3);
    expect(life.listPersonas()).toHaveLength(7);
  });

  it('rejects illegal transitions and leaves the row unchanged', async () => {
    const fixture = openFixture();
    const life = lifecycle(fixture);
    const created = await life.createPersona({ displayName: CANARY });

    expect(await codeOf(() => life.suspendPersona(created.id))).toBe('illegal_transition');
    expect(await codeOf(() => life.resumePersona(created.id))).toBe('illegal_transition');

    const running = await life.startPersona(created.id);
    expect(await codeOf(() => life.startPersona(created.id))).toBe('illegal_transition');
    expect(await codeOf(() => life.resumePersona(created.id))).toBe('illegal_transition');
    expect(life.getPersona(created.id)).toMatchObject({
      state: 'RUNNING',
      version: running.version,
    });

    const suspended = await life.suspendPersona(created.id);
    expect(await codeOf(() => life.startPersona(created.id))).toBe('illegal_transition');
    expect(await codeOf(() => life.suspendPersona(created.id))).toBe('illegal_transition');
    expect(life.getPersona(created.id)?.version).toBe(suspended.version);

    const failed = await life.createPersona({ displayName: 'Broken' });
    reposOf(fixture.store).personas.commitLifecycle({
      id: failed.id,
      expectedState: 'CREATED',
      expectedVersion: 0,
      nextState: 'FAILED',
      updatedAt: 30,
    });
    expect(await codeOf(() => life.startPersona(failed.id))).toBe('illegal_transition');
    expect(await codeOf(() => life.suspendPersona(failed.id))).toBe('illegal_transition');
    expect(await codeOf(() => life.resumePersona(failed.id))).toBe('illegal_transition');
    expect(reposOf(fixture.store).personas.getById(failed.id)).toMatchObject({
      state: 'FAILED',
      version: 1,
    });

    const starting = await life.createPersona({ displayName: 'Mid' });
    reposOf(fixture.store).personas.commitLifecycle({
      id: starting.id,
      expectedState: 'CREATED',
      expectedVersion: 0,
      nextState: 'STARTING',
      updatedAt: 31,
    });
    expect(await codeOf(() => life.startPersona(starting.id))).toBe('illegal_transition');
    expect(reposOf(fixture.store).personas.getById(starting.id)?.state).toBe('STARTING');

    const rejection = fixture.logs.find((entry) => entry.event === 'persona.transition_rejected');
    expect(rejection?.level).toBe('warn');
    assertNoCanary(fixture);
  });
});

describe('persona lifecycle — crash normalization', () => {
  it('moves STARTING and STOPPING to STOPPED and does not start or duplicate anyone', async () => {
    const fixture = openFixture();
    const life = lifecycle(fixture);
    const created = await life.createPersona({ displayName: 'Stay' });
    const running = await life.createPersona({ displayName: 'Run' });
    await life.startPersona(running.id);
    const suspended = await life.createPersona({ displayName: 'Pause' });
    await life.startPersona(suspended.id);
    await life.suspendPersona(suspended.id);
    const failed = await life.createPersona({ displayName: 'Fail' });
    const starting = await life.createPersona({ displayName: 'Start' });
    const stopping = await life.createPersona({ displayName: 'Stop' });
    const store = reposOf(fixture.store);
    store.personas.commitLifecycle({
      id: failed.id,
      expectedState: 'CREATED',
      expectedVersion: 0,
      nextState: 'FAILED',
      updatedAt: 40,
    });
    store.personas.commitLifecycle({
      id: starting.id,
      expectedState: 'CREATED',
      expectedVersion: 0,
      nextState: 'STARTING',
      updatedAt: 41,
      bootId: BOOT_B,
    });
    store.personas.commitLifecycle({
      id: stopping.id,
      expectedState: 'CREATED',
      expectedVersion: 0,
      nextState: 'STOPPING',
      updatedAt: 42,
      bootId: BOOT_B,
    });
    const before = life.listPersonas().length;

    const normalized = await life.normalizeCrashedPersonas();
    const ids = normalized.map((row) => row.id).sort();
    expect(ids).toEqual([starting.id, stopping.id].sort());
    for (const row of normalized) {
      expect(row.state).toBe('STOPPED');
      expect(row.version).toBe(2);
      expect(row.epoch).toBe(1);
      expect(row.bootId).toBe(BOOT_B);
      expect(row.runtimeState).toMatchObject({ state: 'STOPPED', epoch: 1, bootId: BOOT_B });
    }

    expect(life.listPersonas()).toHaveLength(before);
    expect(life.getPersona(created.id)?.state).toBe('CREATED');
    expect(life.getPersona(running.id)).toMatchObject({ state: 'RUNNING', version: 2 });
    expect(life.getPersona(suspended.id)?.state).toBe('SUSPENDED');
    expect(life.getPersona(failed.id)?.state).toBe('FAILED');

    const restarted = await life.startPersona(starting.id);
    expect(restarted.id).toBe(starting.id);
    expect(restarted.state).toBe('RUNNING');
    expect(life.listPersonas()).toHaveLength(before);
    expect(await life.normalizeCrashedPersonas()).toEqual([]);
  });

  it('normalizes a persona once when two scans overlap', async () => {
    const fixture = openFixture();
    const life = lifecycle(fixture);
    const created = await life.createPersona({ displayName: 'Overlap' });
    reposOf(fixture.store).personas.commitLifecycle({
      id: created.id,
      expectedState: 'CREATED',
      expectedVersion: 0,
      nextState: 'STOPPING',
      updatedAt: 50,
    });

    const [first, second] = await Promise.all([
      life.normalizeCrashedPersonas(),
      life.normalizeCrashedPersonas(),
    ]);
    expect(first.length + second.length).toBe(1);
    expect(life.getPersona(created.id)).toMatchObject({ state: 'STOPPED', version: 2, epoch: 1 });
  });
});

describe('persona lifecycle — isolation and version conflicts', () => {
  it('does not let one persona clobber another, including under concurrent writes', async () => {
    const fixture = openFixture();
    let entered = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const life = lifecycle(fixture, BOOT_A, {
      beforeCommit: () => {
        entered += 1;
        if (entered === 2) {
          release?.();
        }
        return gate;
      },
    });
    const left = await life.createPersona({ displayName: 'Left' });
    const right = await life.createPersona({ displayName: 'Right' });

    const pending = Promise.all([life.startPersona(left.id), life.startPersona(right.id)]);
    const outcome = await Promise.race([
      pending.then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), 2_000);
      }),
    ]);
    expect(outcome).toBe('done');
    expect(entered).toBeGreaterThanOrEqual(2);
    const [startedLeft, startedRight] = await pending;
    expect(startedLeft).toMatchObject({ id: left.id, state: 'RUNNING', version: 2 });
    expect(startedRight).toMatchObject({ id: right.id, state: 'RUNNING', version: 2 });

    const quiet = lifecycle(fixture, BOOT_B);
    await Promise.all([quiet.suspendPersona(left.id), quiet.stopPersona(right.id)]);
    expect(quiet.getPersona(left.id)).toMatchObject({ state: 'SUSPENDED', epoch: 1 });
    expect(quiet.getPersona(right.id)).toMatchObject({
      state: 'STOPPED',
      epoch: 1,
      bootId: BOOT_A,
    });
    expect(quiet.listPersonas()).toHaveLength(2);
  });

  it('serializes two operations on one persona instead of applying both reads', async () => {
    const fixture = openFixture();
    let commits = 0;
    const life = lifecycle(fixture, BOOT_A, {
      beforeCommit: () => {
        commits += 1;
        return Promise.resolve();
      },
    });
    const persona = await life.createPersona({ displayName: 'Serial' });
    await life.startPersona(persona.id);
    const afterStart = commits;

    const results = await Promise.allSettled([
      life.suspendPersona(persona.id),
      life.suspendPersona(persona.id),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejection = rejected[0];
    expect(rejection?.status).toBe('rejected');
    if (rejection?.status === 'rejected') {
      expect(rejection.reason).toBeInstanceOf(RuntimeError);
      expect((rejection.reason as RuntimeError).code).toBe('illegal_transition');
    }
    expect(commits).toBe(afterStart + 1);
    expect(life.getPersona(persona.id)).toMatchObject({ state: 'SUSPENDED', version: 3 });
  });

  it('refuses a stale version instead of overwriting the row', async () => {
    const fixture = openFixture();
    const stored = reposOf(fixture.store);
    const life = lifecycle(fixture, BOOT_A, {
      beforeCommit: (view) => {
        const bumped = stored.personas.compareAndSetState({
          id: view.id,
          expectedState: view.state,
          expectedVersion: view.version,
          nextState: view.state,
          updatedAt: 70,
        });
        expect(bumped).toMatchObject({ state: 'CREATED', version: 1 });
      },
    });
    const persona = await life.createPersona({ displayName: CANARY });
    expect(await codeOf(() => life.startPersona(persona.id))).toBe('version_conflict');
    expect(stored.personas.getById(persona.id)).toMatchObject({
      state: 'CREATED',
      version: 1,
      epoch: 1,
      updatedAt: 70,
    });
    expect(stored.runtimeState.get(persona.id)).toMatchObject({ state: 'CREATED', epoch: 1 });
    expect(life.getPersona(persona.id)?.state).toBe('CREATED');
    assertNoCanary(fixture);
  });
});

describe('persona lifecycle — arguments', () => {
  it('rejects a bad boot id, clock, logger, or persona id before writing', async () => {
    const fixture = openFixture();
    expect(() =>
      createPersonaLifecycle({
        store: fixture.store,
        logger: fixture.logger,
        bootId: 'bad boot' as BootId,
      }),
    ).toThrow(RuntimeError);
    expect(() =>
      createPersonaLifecycle({
        store: fixture.store,
        logger: { ...fixture.logger, info: undefined as unknown as RuntimeLogger['info'] },
        bootId: BOOT_A,
      }),
    ).toThrow(RuntimeError);

    const life = createPersonaLifecycle({
      store: fixture.store,
      logger: fixture.logger,
      bootId: BOOT_A,
      now: () => -1,
    });
    expect(await codeOf(() => life.createPersona({ displayName: 'Clock' }))).toBe('invalid_clock');
    expect(life.listPersonas()).toEqual([]);
    expect(await codeOf(() => life.getPersona('not-a-persona' as PersonaId))).toBe(
      'invalid_argument',
    );
  });
});

describe('persona lifecycle — logger failures stay diagnostic', () => {
  it('returns the committed persona when info logging throws after create', async () => {
    const fixture = openFixture();
    const life = lifecycle(fixture, BOOT_A, { logger: throwingLogger('info') });
    const pending = promiseOf(() => life.createPersona({ displayName: 'Logged' }));
    const created = (await pending) as PersonaSnapshot;
    expect(created).toMatchObject({
      state: 'CREATED',
      version: 0,
      epoch: 1,
      runtimeState: { state: 'CREATED', epoch: 1 },
    });
    expect(reposOf(fixture.store).personas.getById(created.id)).toMatchObject({
      state: 'CREATED',
      version: 0,
    });
  });

  it('finishes RUNNING when info logging throws after the STARTING commit', async () => {
    const fixture = openFixture();
    const plain = lifecycle(fixture);
    const created = await plain.createPersona({ displayName: 'Phase' });
    const life = lifecycle(fixture, BOOT_A, { logger: throwingLogger('info') });
    const started = (await promiseOf(() => life.startPersona(created.id))) as PersonaSnapshot;
    expect(started).toMatchObject({
      state: 'RUNNING',
      version: 2,
      bootId: BOOT_A,
      runtimeState: { state: 'RUNNING', bootId: BOOT_A },
    });
    expect(reposOf(fixture.store).personas.getById(created.id)?.state).toBe('RUNNING');
  });

  it('still rejects with illegal_transition when the warn logger throws', async () => {
    const fixture = openFixture();
    const plain = lifecycle(fixture);
    const created = await plain.createPersona({ displayName: 'Illegal' });
    const life = lifecycle(fixture, BOOT_A, { logger: throwingLogger('warn') });
    const pending = promiseOf(() => life.suspendPersona(created.id));
    await expect(pending).rejects.toMatchObject({
      name: 'RuntimeError',
      code: 'illegal_transition',
    });
    await expect(pending).rejects.not.toMatchObject({ message: 'log-failed' });
    expect(reposOf(fixture.store).personas.getById(created.id)?.state).toBe('CREATED');
  });
});

describe('persona lifecycle — crash normalize boot boundary', () => {
  it('normalizes other boots and leaves rows owned by this boot', async () => {
    const fixture = openFixture();
    const life = lifecycle(fixture, BOOT_A);
    const store = reposOf(fixture.store);

    async function seed(label: string, state: 'STARTING' | 'STOPPING', bootId: BootId | null) {
      const created = await life.createPersona({ displayName: label });
      const written = store.personas.commitLifecycle({
        id: created.id,
        expectedState: 'CREATED',
        expectedVersion: 0,
        nextState: state,
        updatedAt: 80,
        ...(bootId === null ? {} : { bootId }),
      });
      expect(written?.persona.bootId ?? null).toBe(bootId);
      return created.id;
    }

    const oldStarting = await seed('old-start', 'STARTING', BOOT_B);
    const oldStopping = await seed('old-stop', 'STOPPING', BOOT_B);
    const unstamped = await seed('unstamped', 'STARTING', null);
    const ownStarting = await seed('own-start', 'STARTING', BOOT_A);
    const ownStopping = await seed('own-stop', 'STOPPING', BOOT_A);

    const normalized = await life.normalizeCrashedPersonas();
    expect(normalized.map((row) => row.id).sort()).toEqual(
      [oldStarting, oldStopping, unstamped].sort(),
    );
    for (const row of normalized) {
      expect(row).toMatchObject({ state: 'STOPPED', version: 2, epoch: 1 });
      expect(row.runtimeState?.state).toBe('STOPPED');
      expect(row.runtimeState?.epoch).toBe(1);
    }
    expect(life.getPersona(ownStarting)).toMatchObject({
      state: 'STARTING',
      version: 1,
      bootId: BOOT_A,
    });
    expect(life.getPersona(ownStopping)).toMatchObject({
      state: 'STOPPING',
      version: 1,
      bootId: BOOT_A,
    });
  });

  it('does not let a same-boot normalize clobber an in-flight start', async () => {
    const fixture = openFixture();
    const normalizer = lifecycle(fixture, BOOT_A);
    const starter = lifecycle(fixture, BOOT_A, {
      beforeCommit: (view) => {
        if (view.state !== 'STARTING') {
          return undefined;
        }
        return normalizer.normalizeCrashedPersonas().then((rows) => {
          expect(rows).toEqual([]);
        });
      },
    });
    const created = await normalizer.createPersona({ displayName: 'InFlight' });
    const started = await starter.startPersona(created.id);
    expect(started).toMatchObject({
      id: created.id,
      state: 'RUNNING',
      version: 2,
      bootId: BOOT_A,
      epoch: 1,
    });
    expect(reposOf(fixture.store).personas.list()).toHaveLength(1);
  });
});

describe('persona lifecycle — consistent reads', () => {
  it('keeps persona and runtime_state paired when another connection commits mid-read', async () => {
    const fixture = openFixture();
    const created = await lifecycle(fixture).createPersona({ displayName: 'Paired' });
    const other = openStore({ file: fixture.store.file });
    const writer = reposOf(other).runtimeState;
    const writeStopped = (): void => {
      writer.upsert({
        personaId: created.id,
        state: 'STOPPED',
        bootId: null,
        epoch: 1,
        updatedAt: 9_000,
      });
    };
    const park = (): void => {
      writer.upsert({
        personaId: created.id,
        state: 'CREATED',
        bootId: null,
        epoch: 1,
        updatedAt: 1,
      });
    };
    const reader = lifecycle(fixture, BOOT_A, { duringRead: writeStopped });
    try {
      expect(reader.getPersona(created.id)).toMatchObject({
        state: 'CREATED',
        runtimeState: { state: 'CREATED' },
      });

      park();
      const listed = reader.listPersonas();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        state: 'CREATED',
        runtimeState: { state: 'CREATED' },
      });

      park();
      expect(reader.queryPersonas({ state: 'CREATED' })[0]?.runtimeState?.state).toBe('CREATED');

      expect(lifecycle(fixture).getPersona(created.id)).toMatchObject({
        state: 'CREATED',
        runtimeState: { state: 'STOPPED' },
      });
    } finally {
      other.close();
    }
  });
});

describe('persona lifecycle — promise rejection', () => {
  it('rejects invalid input on the returned promise', async () => {
    const fixture = openFixture();
    const life = lifecycle(fixture);
    const created = promiseOf(() => life.createPersona({ displayName: '' }));
    await expect(created).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(life.listPersonas()).toEqual([]);

    const started = promiseOf(() => life.startPersona('not-a-persona' as PersonaId));
    await expect(started).rejects.toMatchObject({
      name: 'RuntimeError',
      code: 'invalid_argument',
    });
  });
});
