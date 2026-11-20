/**
 * Cross-package consumer check — runtime half.
 *
 * Imports the packages by name (resolved through the workspace link) and asserts
 * that the built ESM entry actually exposes the intended surface. Runs after
 * `pnpm run build`, so it validates `dist/`, not the sources.
 *
 * For persistence this goes further than symbol sniffing: it opens a real
 * database file, runs the shipped migrations (proving `defaultMigrationsDir`
 * resolves correctly from `dist/`), writes through a repository, saves and reads
 * a checkpoint, and closes. That is the "future Runtime consumes this package"
 * claim, executed.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ERROR_MESSAGES,
  SCHEMA_IDS,
  STIMULUS_INPUT_VERSION,
  isCoreId,
  isPersonaId,
  isTaskId,
  stimulusInputV1Schema,
} from '@soul-harness/contracts';
import * as persistence from '@soul-harness/persistence';
import * as runtime from '@soul-harness/runtime';

assert.equal(SCHEMA_IDS.length, 10, 'expected 10 registered schemas');
assert.equal(STIMULUS_INPUT_VERSION, 'soul.stimulus.input.v1');
assert.equal(stimulusInputV1Schema.$id, 'soul.stimulus.input.v1');
assert.equal(isPersonaId('psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC'), true);
assert.equal(isCoreId('tsk_01JQ8Z6B7P9R1T3V5X7Z9A2BDF'), false);
assert.equal(ERROR_MESSAGES.schema_invalid, 'envelope failed schema validation');

// --- the published surface must not leak internals ---------------------------

for (const internal of [
  'databaseOf',
  'readDatabaseOf',
  'setReadGuardFaultForTests',
  'takeReadGuardFault',
  'createGuardedStatement',
]) {
  assert.equal(internal in persistence, false, `${internal} must not be exported`);
}

const { createRepositories, isPersistenceError, migrate, openStore, withRead, withWrite } =
  persistence;

const PERSONA = 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC';
const NOW = 1_731_700_000_000;
const dir = mkdtempSync(join(tmpdir(), 'sh-consumer-'));

try {
  const store = openStore({ file: join(dir, 'soul.db') });

  const result = migrate(store);
  assert.deepEqual(result.applied, [1], 'the shipped migrations must apply');
  assert.equal(result.currentVersion, 1);

  const repos = createRepositories(store);
  repos.personas.insert({
    id: PERSONA,
    displayName: 'Consumer',
    state: 'RUNNING',
    createdAt: NOW,
    updatedAt: NOW,
  });
  repos.runtimeState.upsert({ personaId: PERSONA, state: 'RUNNING', epoch: 1, updatedAt: NOW });
  repos.checkpoints.save({
    personaId: PERSONA,
    epoch: 1,
    refs: { cursor: 'consumer:0' },
    updatedAt: NOW + 1,
  });

  const loaded = repos.checkpoints.load(PERSONA);
  assert.equal(loaded.status, 'present');
  assert.equal(loaded.stored.checkpoint.refs.cursor, 'consumer:0');
  assert.equal(repos.personas.getById(PERSONA).displayName, 'Consumer');

  // Transaction surface: no arbitrary SQL entry point, read scopes are read-only.
  withWrite(store, (tx) => {
    assert.equal('exec' in tx, false, 'Tx must not expose exec');
  });

  const readCount = withRead(
    store,
    (tx) => tx.prepare('SELECT count(*) AS n FROM personas').get().n,
  );
  assert.equal(readCount, 1);

  let rejected = false;
  try {
    withRead(store, (tx) => tx.prepare('INSERT INTO personas (id) VALUES (?)').run('psn_x'));
  } catch (error) {
    rejected = isPersistenceError(error) && error.code === 'statement_blocked';
  }
  assert.equal(rejected, true, 'read scope must refuse writes');

  store.close();
  assert.throws(
    () => repos.personas.getById(PERSONA),
    (error) => isPersistenceError(error) && error.code === 'store_closed',
  );
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

// --- runtime: allocator plus in-process persona lifecycle, nothing later -----

for (const absent of [
  'createRuntime',
  'acceptStimulus',
  'enqueueTask',
  'recover',
  'checkpointAll',
]) {
  assert.equal(absent in runtime, false, `${absent} must not be exported yet`);
}

assert.equal(typeof runtime.createPersonaLifecycle, 'function');
assert.equal(runtime.PERSONA_DISPLAY_NAME_MAX_LENGTH, 128);

const allocated = runtime.allocatePersonaId();
assert.equal(typeof allocated, 'string');
assert.equal(allocated.length, 30);
assert.equal(isPersonaId(allocated), true);
assert.equal(isCoreId(runtime.allocateTaskId()), false);
assert.equal(isTaskId(runtime.allocateTaskId()), true);
assert.equal(runtime.ID_ALLOCATION_MAX_ATTEMPTS, 8);
assert.equal(runtime.ID_ENTROPY_BYTES, 10);

const fixed = runtime.allocateEventId({
  now: () => 0,
  randomBytes: () => new Uint8Array(10),
});
assert.equal(fixed, `evt_${'0'.repeat(26)}`);

let occupied = true;
const retried = runtime.allocateEventId({
  now: () => 0,
  randomBytes: () => {
    const bytes = new Uint8Array(10);
    bytes[0] = occupied ? 1 : 2;
    return bytes;
  },
  isOccupied: () => {
    const taken = occupied;
    occupied = false;
    return taken;
  },
});
assert.notEqual(retried, fixed);
assert.equal(isCoreId(retried), true);

assert.throws(
  () =>
    runtime.allocateRunId({
      now: () => 0,
      randomBytes: () => new Uint8Array(10),
      isOccupied: () => true,
      maxAttempts: 2,
    }),
  (error) => runtime.isRuntimeError(error) && error.code === 'id_collision',
);

const runtimeDir = mkdtempSync(join(tmpdir(), 'sh-consumer-runtime-'));
try {
  const runtimeStore = persistence.openStore({ file: join(runtimeDir, 'soul.db') });
  persistence.migrate(runtimeStore);
  const noop = { debug() {}, info() {}, warn() {}, error() {} };
  const life = runtime.createPersonaLifecycle({
    store: runtimeStore,
    logger: noop,
    bootId: 'consumer-boot',
  });
  const created = await life.createPersona({ displayName: 'Consumer' });
  assert.equal(isPersonaId(created.id), true);
  assert.equal(created.state, 'CREATED');
  assert.equal(created.epoch, 1);
  assert.equal(created.version, 0);
  const started = await life.startPersona(created.id);
  assert.equal(started.state, 'RUNNING');
  assert.equal(started.version, 2);
  assert.equal(started.bootId, 'consumer-boot');
  assert.equal(started.epoch, 1);
  assert.equal(started.runtimeState.epoch, 1);
  const suspended = await life.suspendPersona(created.id);
  assert.equal(suspended.state, 'SUSPENDED');
  const resumed = await life.resumePersona(created.id);
  assert.equal(resumed.state, 'RUNNING');
  const stopped = await life.stopPersona(created.id);
  assert.equal(stopped.state, 'STOPPED');
  assert.equal(stopped.version, 6);
  const restored = life.restorePersona(created.id);
  assert.equal(restored.id, created.id);
  assert.equal(life.listPersonas().length, 1);
  await life.startPersona(created.id);
  await assert.rejects(
    life.startPersona(created.id),
    (error) => runtime.isRuntimeError(error) && error.code === 'illegal_transition',
  );
  runtimeStore.close();
} finally {
  rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log(
  `consumer-check ok: package-name imports resolved, ${SCHEMA_IDS.length} schemas, persistence E2E ok, runtime persona lifecycle ok`,
);
