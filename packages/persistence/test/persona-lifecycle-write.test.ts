/**
 * Persona lifecycle writes added for SH-008B.
 *
 * `insertWithRuntimeState` and `commitLifecycle` are storage operations: they
 * do not decide which transition is legal. They do have to make the persona
 * row and `runtime_state` land together, copy epoch instead of accepting a new
 * one, and leave `checkpoint_json` alone.
 */

import type { BootId, PersonaId } from '@soul-harness/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { createRepositories, isPersistenceError, withWrite } from '../src/index.js';
import type { PersonaState } from '../src/index.js';
import { closeAll, NOW, openMigratedStore } from './helpers/fixture.js';

afterEach(closeAll);

const BODY = '01JQ8Z3K5M7P9R2T4V6X8Z';
const PERSONA = `psn_${BODY}00B1` as PersonaId;
const BOOT = 'boot-sh008b' as BootId;

function seed(store: ReturnType<typeof openMigratedStore>) {
  const repos = createRepositories(store);
  const written = repos.personas.insertWithRuntimeState({
    id: PERSONA,
    displayName: 'Lifecycle',
    state: 'CREATED',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { repos, written };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isPersistenceError(error)) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('personas.insertWithRuntimeState', () => {
  it('writes the persona and runtime_state together, with default version and epoch', () => {
    const store = openMigratedStore();
    const { repos, written } = seed(store);

    expect(written.persona).toMatchObject({
      id: PERSONA,
      displayName: 'Lifecycle',
      state: 'CREATED',
      version: 0,
      epoch: 1,
      bootId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(written.runtimeState).toMatchObject({
      personaId: PERSONA,
      state: 'CREATED',
      bootId: null,
      epoch: 1,
      updatedAt: NOW,
    });
    expect(repos.personas.getById(PERSONA)).toMatchObject({ version: 0, epoch: 1 });
    expect(repos.runtimeState.get(PERSONA)).toMatchObject({ state: 'CREATED', epoch: 1 });
    expect(repos.checkpoints.load(PERSONA)).toEqual({ status: 'absent' });
  });

  it('rejects a bad id, state, or boot id before opening a transaction', () => {
    const store = openMigratedStore();
    const repos = createRepositories(store);
    const base = {
      id: PERSONA,
      displayName: 'Lifecycle',
      state: 'CREATED' as const,
      createdAt: NOW,
      updatedAt: NOW,
    };

    expect(
      codeOf(() => repos.personas.insertWithRuntimeState({ ...base, id: 'nope' as PersonaId })),
    ).toBe('invalid_identifier');
    expect(
      codeOf(() =>
        repos.personas.insertWithRuntimeState({ ...base, state: 'running' as PersonaState }),
      ),
    ).toBe('invalid_argument');
    expect(
      codeOf(() =>
        repos.personas.insertWithRuntimeState({ ...base, bootId: 'bad boot' as BootId }),
      ),
    ).toBe('invalid_identifier');
    expect(repos.personas.getById(PERSONA)).toBeNull();
    expect(repos.runtimeState.get(PERSONA)).toBeNull();
  });
});

describe('personas.commitLifecycle', () => {
  it('bumps version by one, stamps bootId, and mirrors runtime_state', () => {
    const store = openMigratedStore();
    const { repos } = seed(store);

    const written = repos.personas.commitLifecycle({
      id: PERSONA,
      expectedState: 'CREATED',
      expectedVersion: 0,
      nextState: 'STARTING',
      updatedAt: NOW + 5,
      bootId: BOOT,
    });

    expect(written).toMatchObject({
      persona: { state: 'STARTING', version: 1, epoch: 1, bootId: BOOT, updatedAt: NOW + 5 },
      runtimeState: { state: 'STARTING', epoch: 1, bootId: BOOT, updatedAt: NOW + 5 },
    });
    expect(repos.personas.getById(PERSONA)).toMatchObject({
      state: 'STARTING',
      version: 1,
      bootId: BOOT,
    });
    expect(repos.runtimeState.get(PERSONA)).toMatchObject({ state: 'STARTING', bootId: BOOT });
  });

  it('keeps the existing boot id when the caller omits it, and can clear it with null', () => {
    const store = openMigratedStore();
    const { repos } = seed(store);
    repos.personas.commitLifecycle({
      id: PERSONA,
      expectedState: 'CREATED',
      expectedVersion: 0,
      nextState: 'STARTING',
      updatedAt: NOW + 1,
      bootId: BOOT,
    });

    const kept = repos.personas.commitLifecycle({
      id: PERSONA,
      expectedState: 'STARTING',
      expectedVersion: 1,
      nextState: 'RUNNING',
      updatedAt: NOW + 2,
    });
    expect(kept?.persona.bootId).toBe(BOOT);
    expect(kept?.runtimeState.bootId).toBe(BOOT);

    const cleared = repos.personas.commitLifecycle({
      id: PERSONA,
      expectedState: 'RUNNING',
      expectedVersion: 2,
      nextState: 'SUSPENDED',
      updatedAt: NOW + 3,
      bootId: null,
    });
    expect(cleared?.persona.bootId).toBeNull();
    expect(cleared?.runtimeState.bootId).toBeNull();
    expect(repos.personas.getById(PERSONA)?.version).toBe(3);
  });

  it('writes nothing when the expected state or version does not match', () => {
    const store = openMigratedStore();
    const { repos } = seed(store);

    expect(
      repos.personas.commitLifecycle({
        id: PERSONA,
        expectedState: 'RUNNING',
        expectedVersion: 0,
        nextState: 'STOPPED',
        updatedAt: NOW + 4,
        bootId: BOOT,
      }),
    ).toBeNull();
    expect(
      repos.personas.commitLifecycle({
        id: PERSONA,
        expectedState: 'CREATED',
        expectedVersion: 9,
        nextState: 'STOPPED',
        updatedAt: NOW + 5,
      }),
    ).toBeNull();

    expect(repos.personas.getById(PERSONA)).toMatchObject({
      state: 'CREATED',
      version: 0,
      epoch: 1,
      bootId: null,
      updatedAt: NOW,
    });
    expect(repos.runtimeState.get(PERSONA)).toMatchObject({
      state: 'CREATED',
      epoch: 1,
      bootId: null,
      updatedAt: NOW,
    });
  });

  it('returns null for a missing persona and does not create runtime_state', () => {
    const store = openMigratedStore();
    const repos = createRepositories(store);
    const missing = `psn_${BODY}00B2` as PersonaId;

    expect(
      repos.personas.commitLifecycle({
        id: missing,
        expectedState: 'CREATED',
        expectedVersion: 0,
        nextState: 'STOPPED',
        updatedAt: NOW,
      }),
    ).toBeNull();
    expect(repos.runtimeState.get(missing)).toBeNull();
  });

  it('copies the stored epoch and does not touch an existing checkpoint', () => {
    const store = openMigratedStore();
    const { repos } = seed(store);
    withWrite(store, (tx) => {
      tx.prepare('UPDATE personas SET epoch = ? WHERE id = ?').run(7, PERSONA);
      tx.prepare('UPDATE runtime_state SET epoch = ? WHERE persona_id = ?').run(7, PERSONA);
    });
    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 7,
      refs: { cursor: 'sched:0:4' },
      updatedAt: NOW + 1,
    });

    const written = repos.personas.commitLifecycle({
      id: PERSONA,
      expectedState: 'CREATED',
      expectedVersion: 0,
      nextState: 'RUNNING',
      updatedAt: NOW + 8,
      bootId: BOOT,
    });

    expect(written?.persona.epoch).toBe(7);
    expect(written?.persona.version).toBe(1);
    expect(written?.runtimeState.epoch).toBe(7);
    expect(repos.personas.getById(PERSONA)?.epoch).toBe(7);
    expect(repos.runtimeState.get(PERSONA)).toMatchObject({
      state: 'RUNNING',
      epoch: 7,
      bootId: BOOT,
    });
    const loaded = repos.checkpoints.load(PERSONA);
    expect(loaded.status).toBe('present');
    if (loaded.status === 'present') {
      expect(loaded.stored.checkpoint.epoch).toBe(7);
      expect(loaded.stored.checkpoint.refs?.cursor).toBe('sched:0:4');
    }
  });

  it('creates the runtime row when a bare persona insert never wrote one', () => {
    const store = openMigratedStore();
    const repos = createRepositories(store);
    repos.personas.insert({
      id: PERSONA,
      displayName: 'Bare',
      state: 'CREATED',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(repos.runtimeState.get(PERSONA)).toBeNull();

    const written = repos.personas.commitLifecycle({
      id: PERSONA,
      expectedState: 'CREATED',
      expectedVersion: 0,
      nextState: 'STOPPED',
      updatedAt: NOW + 2,
    });

    expect(written?.runtimeState).toMatchObject({ state: 'STOPPED', epoch: 1 });
    expect(repos.checkpoints.load(PERSONA)).toEqual({ status: 'absent' });
  });

  it('rejects invalid arguments before changing a stored row', () => {
    const store = openMigratedStore();
    const { repos } = seed(store);
    const base = {
      id: PERSONA,
      expectedState: 'CREATED' as const,
      expectedVersion: 0,
      nextState: 'STARTING' as const,
      updatedAt: NOW + 1,
    };

    expect(codeOf(() => repos.personas.commitLifecycle({ ...base, expectedVersion: 1.5 }))).toBe(
      'invalid_argument',
    );
    expect(codeOf(() => repos.personas.commitLifecycle({ ...base, expectedVersion: -1 }))).toBe(
      'invalid_argument',
    );
    expect(
      codeOf(() =>
        repos.personas.commitLifecycle({ ...base, nextState: 'running' as PersonaState }),
      ),
    ).toBe('invalid_argument');
    expect(
      codeOf(() => repos.personas.commitLifecycle({ ...base, bootId: 'bad boot' as BootId })),
    ).toBe('invalid_identifier');
    expect(repos.personas.getById(PERSONA)).toMatchObject({ state: 'CREATED', version: 0 });
    expect(repos.runtimeState.get(PERSONA)).toMatchObject({ state: 'CREATED', epoch: 1 });
  });
});
