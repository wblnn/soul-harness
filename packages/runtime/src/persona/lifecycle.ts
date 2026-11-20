/**
 * In-process persona lifecycle (SH-008B).
 *
 * Authority for the states is RUNTIME-LIFECYCLE §5. Authority for continuity
 * is IDENTITY-PROTOCOL R11: a persona id is allocated once, and a later boot
 * loads that row instead of inserting another.
 *
 * What this file refuses to be:
 *   - no event bus, scheduler, recovery scan, or checkpoint load/save
 *     (those are SH-008C–E; start and stop only move the lifecycle rows)
 *   - no raw SQL and no column mapping; every read and write goes through
 *     `@soul-harness/persistence`
 *   - no caller-supplied persona id
 *   - no epoch increment. Forgotten content is a later phase. The stored
 *     epoch is copied by the persistence commit and never sent as a new value
 *   - no automatic start after a crash. STARTING and STOPPING left by another
 *     boot become STOPPED and wait for an explicit start. Rows this boot
 *     already owns stay as they are
 */

import { isBootId, isPersonaId } from '@soul-harness/contracts';
import type { BootId, PersonaId } from '@soul-harness/contracts';
import {
  createRepositories,
  isPersistenceError,
  MAX_LIST_LIMIT,
  PERSONA_STATES,
  Store,
  withRead,
} from '@soul-harness/persistence';
import type { PersonaRow, PersonaState, RuntimeStateRow } from '@soul-harness/persistence';

import { RuntimeError } from '../errors.js';
import { allocatePersonaId } from '../ids/allocate.js';
import type { AllocateOptions } from '../ids/allocate.js';
import { createKeyedQueue } from './queue.js';

/** Implementation limit. The personas table has no length check of its own. */
export const PERSONA_DISPLAY_NAME_MAX_LENGTH = 128;

const CREATE_QUEUE_KEY = '\0create';

const CRASH_STATES: readonly PersonaState[] = ['STARTING', 'STOPPING'];

export type RuntimeLogFields = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Structural logger. A Daemon logger satisfies it. Fields are scalars so a
 * display name cannot be smuggled in as a nested object. Callers still must
 * not put a display name in a string field; this module never does.
 */
export interface RuntimeLogger {
  debug(event: string, fields?: RuntimeLogFields): void;
  info(event: string, fields?: RuntimeLogFields): void;
  warn(event: string, fields?: RuntimeLogFields): void;
  error(event: string, fields?: RuntimeLogFields): void;
}

/** The row a commit is about to compare against. No display name. */
export interface PersonaCommitView {
  readonly id: PersonaId;
  readonly state: PersonaState;
  readonly version: number;
  readonly epoch: number;
}

export interface PersonaLifecycleOptions {
  readonly store: Store;
  readonly logger: RuntimeLogger;
  /** Process boot id. Stamped when a persona starts or resumes. Not allocated here. */
  readonly bootId: BootId;
  /** Unix milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /** Forwarded to the persona id allocator. Default `crypto.randomBytes`. */
  readonly randomBytes?: (size: number) => Uint8Array;
  /**
   * Test seam. Production callers omit it.
   *
   * Invoked inside the persona write queue after the transition has been
   * judged legal and before the compare-and-set. A returned promise is
   * awaited, which is the window an external writer can use to make the
   * following commit fail with `version_conflict`.
   */
  readonly beforeCommit?: (persona: PersonaCommitView) => void | Promise<void>;
  /**
   * Test seam. Production callers omit it.
   *
   * Invoked inside the read transaction after the persona row (or page) has
   * been read and before `runtime_state` is read. A second connection can
   * commit there; this connection must still return the pre-commit pair.
   */
  readonly duringRead?: () => void;
}

/** Runtime row as observed with the persona. `null` when the mirror is missing. */
export interface PersonaRuntimeSnapshot {
  readonly state: string;
  readonly bootId: BootId | null;
  readonly epoch: number;
  readonly updatedAt: number;
}

export interface PersonaSnapshot {
  readonly id: PersonaId;
  readonly displayName: string;
  readonly state: PersonaState;
  readonly version: number;
  readonly epoch: number;
  readonly bootId: BootId | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly runtimeState: PersonaRuntimeSnapshot | null;
}

export interface PersonaQuery {
  readonly state?: PersonaState;
}

export interface PersonaLifecycle {
  createPersona(input: { readonly displayName: string }): Promise<PersonaSnapshot>;
  getPersona(personaId: PersonaId): PersonaSnapshot | null;
  /** Every persona, keyset-ordered by id. Walks pages so a long table is not truncated. */
  listPersonas(): readonly PersonaSnapshot[];
  /** Same walk as {@link PersonaLifecycle.listPersonas}, optionally filtered by state. */
  queryPersonas(query: PersonaQuery): readonly PersonaSnapshot[];
  startPersona(personaId: PersonaId): Promise<PersonaSnapshot>;
  suspendPersona(personaId: PersonaId): Promise<PersonaSnapshot>;
  resumePersona(personaId: PersonaId): Promise<PersonaSnapshot>;
  stopPersona(personaId: PersonaId): Promise<PersonaSnapshot>;
  /**
   * Load the persona that already has this id.
   * Does not allocate and does not insert. A missing id is `not_found`.
   */
  restorePersona(personaId: PersonaId): PersonaSnapshot;
  /**
   * Old-boot STARTING and STOPPING become STOPPED. Nothing is started.
   *
   * A row whose `bootId` is already this lifecycle's boot id is in-flight work
   * of the current boot and is not a crash leftover. Epoch is not changed.
   * Other states, including FAILED, are left untouched.
   *
   * Precondition, enforced by the Daemon in SH-008E and not here: the
   * supervisor calls this during its exclusive RECOVERING phase, before this
   * boot starts or stops any persona. The boot id check is the local guard
   * for that window; it does not replace the single-supervisor rule.
   */
  normalizeCrashedPersonas(): Promise<readonly PersonaSnapshot[]>;
}

type PersonaOperation = 'start' | 'suspend' | 'resume' | 'stop' | 'normalize';

export function createPersonaLifecycle(options: PersonaLifecycleOptions): PersonaLifecycle {
  assertOptions(options);
  const clock = options.now ?? Date.now;
  const repos = createRepositories(options.store);
  const queue = createKeyedQueue();

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

  /**
   * Diagnostic only. A throwing logger must not hide a committed row or
   * replace `illegal_transition` / `version_conflict` with the logger's error.
   */
  function safeLog(
    level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    fields?: RuntimeLogFields,
  ): void {
    try {
      options.logger[level](event, fields);
    } catch {
      // The business result is already decided. Swallow the diagnostic failure.
    }
  }

  function toSnapshot(persona: PersonaRow, runtime: RuntimeStateRow | null): PersonaSnapshot {
    return {
      id: persona.id,
      displayName: persona.displayName,
      state: persona.state,
      version: persona.version,
      epoch: persona.epoch,
      bootId: persona.bootId,
      createdAt: persona.createdAt,
      updatedAt: persona.updatedAt,
      runtimeState:
        runtime === null
          ? null
          : {
              state: runtime.state,
              bootId: runtime.bootId,
              epoch: runtime.epoch,
              updatedAt: runtime.updatedAt,
            },
    };
  }

  function pagePersonaRows(): readonly PersonaRow[] {
    const rows: PersonaRow[] = [];
    let afterId: PersonaId | undefined;
    for (;;) {
      const page = repos.personas.listPage({
        limit: MAX_LIST_LIMIT,
        ...(afterId === undefined ? {} : { afterId }),
      });
      rows.push(...page);
      if (page.length < MAX_LIST_LIMIT) {
        return rows;
      }
      const last = page[page.length - 1];
      if (last === undefined) {
        return rows;
      }
      afterId = last.id;
    }
  }

  /**
   * Persona row and its runtime row, from one read transaction.
   *
   * `duringRead` runs after the persona read and before the runtime read so a
   * test can commit on another connection in between. Both selects stay on
   * this transaction's snapshot.
   */
  function loadOne(personaId: PersonaId): PersonaSnapshot | null {
    return withRead(options.store, () => {
      const persona = repos.personas.getById(personaId);
      options.duringRead?.();
      if (persona === null) {
        return null;
      }
      return toSnapshot(persona, repos.runtimeState.get(personaId));
    });
  }

  function loadAll(state: PersonaState | undefined): readonly PersonaSnapshot[] {
    return withRead(options.store, () => {
      const rows = pagePersonaRows();
      options.duringRead?.();
      return rows
        .filter((row) => state === undefined || row.state === state)
        .map((row) => toSnapshot(row, repos.runtimeState.get(row.id)));
    });
  }

  function requireRow(personaId: PersonaId, operation: string): PersonaRow {
    assertPersonaId(personaId);
    const row = repos.personas.getById(personaId);
    if (row === null) {
      throw new RuntimeError('not_found', 'persona does not exist', {
        details: { operation },
      });
    }
    return row;
  }

  function hookResult(view: PersonaCommitView): void | Promise<void> {
    if (options.beforeCommit === undefined) {
      return undefined;
    }
    return options.beforeCommit(view);
  }

  async function commitStep(
    row: PersonaRow,
    next: PersonaState,
    operation: PersonaOperation,
    bootId: BootId | null | undefined,
  ): Promise<PersonaSnapshot> {
    const waited = hookResult({
      id: row.id,
      state: row.state,
      version: row.version,
      epoch: row.epoch,
    });
    if (isThenable(waited)) {
      await waited;
    }
    const written = repos.personas.commitLifecycle({
      id: row.id,
      expectedState: row.state,
      expectedVersion: row.version,
      nextState: next,
      updatedAt: readClock(),
      ...(bootId === undefined ? {} : { bootId }),
    });
    if (written === null) {
      safeLog('warn', 'persona.version_conflict', {
        personaId: row.id,
        from: row.state,
        expectedVersion: row.version,
        operation,
        bootId: options.bootId,
      });
      throw new RuntimeError('version_conflict', 'persona version or state changed before commit', {
        details: {
          expectedVersion: row.version,
          expectedState: row.state,
          operation,
        },
      });
    }
    safeLog('info', 'persona.transition', {
      personaId: row.id,
      from: row.state,
      to: next,
      version: written.persona.version,
      epoch: written.persona.epoch,
      operation,
      bootId: options.bootId,
    });
    return toSnapshot(written.persona, written.runtimeState);
  }

  async function runOperation(
    personaId: PersonaId,
    operation: Exclude<PersonaOperation, 'normalize'>,
  ): Promise<PersonaSnapshot> {
    assertPersonaId(personaId);
    return queue.run(personaId, async () => {
      const current = requireRow(personaId, operation);
      const steps = planSteps(operation, current.state);
      if (steps === null) {
        safeLog('warn', 'persona.transition_rejected', {
          personaId,
          from: current.state,
          operation,
          bootId: options.bootId,
        });
        throw new RuntimeError(
          'illegal_transition',
          'persona state does not allow this operation',
          {
            details: { from: current.state, operation },
          },
        );
      }
      if (steps.length === 0) {
        const snapshot = loadOne(personaId);
        if (snapshot === null) {
          throw new RuntimeError('not_found', 'persona does not exist', {
            details: { operation },
          });
        }
        return snapshot;
      }
      let row = current;
      let snapshot: PersonaSnapshot | undefined;
      for (const next of steps) {
        snapshot = await commitStep(row, next, operation, bootFor(operation, next));
        const updated = repos.personas.getById(personaId);
        if (updated === null) {
          throw new RuntimeError('not_found', 'persona does not exist', {
            details: { operation },
          });
        }
        row = updated;
      }
      if (snapshot === undefined) {
        throw new RuntimeError(
          'illegal_transition',
          'persona state does not allow this operation',
          {
            details: { from: current.state, operation },
          },
        );
      }
      return snapshot;
    });
  }

  function ownedByThisBoot(bootId: BootId | null): boolean {
    return bootId === options.bootId;
  }

  function bootFor(
    operation: Exclude<PersonaOperation, 'normalize'>,
    next: PersonaState,
  ): BootId | undefined {
    if (operation === 'start' && next === 'STARTING') {
      return options.bootId;
    }
    if (operation === 'resume' && next === 'RUNNING') {
      return options.bootId;
    }
    return undefined;
  }

  return {
    async createPersona(input) {
      if (typeof input !== 'object' || input === null) {
        throw new RuntimeError('invalid_argument', 'createPersona input must be an object');
      }
      assertDisplayName(input.displayName);
      return queue.run(CREATE_QUEUE_KEY, () => {
        const now = readClock();
        const allocateOptions: AllocateOptions = {
          now: () => now,
          isOccupied: (candidate) =>
            isPersonaId(candidate) && repos.personas.getById(candidate) !== null,
          ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
        };
        const id = allocatePersonaId(allocateOptions);
        try {
          const written = repos.personas.insertWithRuntimeState({
            id,
            displayName: input.displayName,
            state: 'CREATED',
            bootId: null,
            createdAt: now,
            updatedAt: now,
          });
          safeLog('info', 'persona.created', {
            personaId: id,
            state: written.persona.state,
            version: written.persona.version,
            epoch: written.persona.epoch,
            bootId: options.bootId,
          });
          return toSnapshot(written.persona, written.runtimeState);
        } catch (error) {
          if (isPersistenceError(error) && error.code === 'unique_conflict') {
            throw new RuntimeError('id_collision', 'persona id collided on insert', {
              cause: error,
            });
          }
          throw error;
        }
      });
    },

    getPersona(personaId) {
      assertPersonaId(personaId);
      return loadOne(personaId);
    },

    listPersonas() {
      return loadAll(undefined);
    },

    queryPersonas(queryInput) {
      if (typeof queryInput !== 'object' || queryInput === null) {
        throw new RuntimeError('invalid_argument', 'query must be an object');
      }
      if (queryInput.state !== undefined && !isPersonaState(queryInput.state)) {
        throw new RuntimeError('invalid_argument', 'query.state must be a persona state', {
          details: { field: 'state' },
        });
      }
      return loadAll(queryInput.state);
    },

    startPersona(personaId) {
      return runOperation(personaId, 'start');
    },

    suspendPersona(personaId) {
      return runOperation(personaId, 'suspend');
    },

    resumePersona(personaId) {
      return runOperation(personaId, 'resume');
    },

    stopPersona(personaId) {
      return runOperation(personaId, 'stop');
    },

    restorePersona(personaId) {
      assertPersonaId(personaId);
      const snapshot = loadOne(personaId);
      if (snapshot === null) {
        throw new RuntimeError('not_found', 'persona does not exist', {
          details: { operation: 'restore' },
        });
      }
      return snapshot;
    },

    async normalizeCrashedPersonas() {
      // Scan outside any persona queue. The queued body re-reads and CAS-es,
      // so a row this boot claims after the scan is not overwritten.
      const crashed = withRead(options.store, () => pagePersonaRows()).filter(
        (row) => isCrashState(row.state) && !ownedByThisBoot(row.bootId),
      );
      const changed: PersonaSnapshot[] = [];
      for (const candidate of crashed) {
        const snapshot = await queue.run(candidate.id, async () => {
          const current = repos.personas.getById(candidate.id);
          if (current === null || !isCrashState(current.state) || ownedByThisBoot(current.bootId)) {
            return null;
          }
          try {
            return await commitStep(current, 'STOPPED', 'normalize', undefined);
          } catch (error) {
            if (error instanceof RuntimeError && error.code === 'version_conflict') {
              const again = repos.personas.getById(candidate.id);
              if (again === null || !isCrashState(again.state) || ownedByThisBoot(again.bootId)) {
                return null;
              }
            }
            throw error;
          }
        });
        if (snapshot !== null) {
          changed.push(snapshot);
        }
      }
      return changed;
    },
  };
}

/**
 * Legal steps for one operation.
 *
 * `null` rejects the call. An empty list is a successful no-op (stop of an
 * already STOPPED persona). Start is accepted from CREATED and from STOPPED:
 * RUNTIME-LIFECYCLE §4 requires an explicit restart after a crash has been
 * normalized to STOPPED, and the diagram's single CREATED arrow does not name
 * that restart. FAILED is not started in place; stop remains available from
 * every state, including FAILED.
 */
function planSteps(
  operation: Exclude<PersonaOperation, 'normalize'>,
  from: PersonaState,
): readonly PersonaState[] | null {
  switch (operation) {
    case 'start':
      return from === 'CREATED' || from === 'STOPPED' ? ['STARTING', 'RUNNING'] : null;
    case 'suspend':
      return from === 'RUNNING' ? ['SUSPENDED'] : null;
    case 'resume':
      return from === 'SUSPENDED' ? ['RUNNING'] : null;
    case 'stop':
      if (from === 'STOPPED') {
        return [];
      }
      if (from === 'STOPPING') {
        return ['STOPPED'];
      }
      return ['STOPPING', 'STOPPED'];
    default:
      return null;
  }
}

function isCrashState(state: PersonaState): boolean {
  return CRASH_STATES.includes(state);
}

function isPersonaState(value: unknown): value is PersonaState {
  return typeof value === 'string' && (PERSONA_STATES as readonly string[]).includes(value);
}

function assertPersonaId(personaId: PersonaId): void {
  if (!isPersonaId(personaId)) {
    throw new RuntimeError('invalid_argument', 'personaId must be a persona id', {
      details: { field: 'personaId' },
    });
  }
}

function assertDisplayName(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > PERSONA_DISPLAY_NAME_MAX_LENGTH
  ) {
    throw new RuntimeError(
      'invalid_argument',
      'displayName must be a string of 1 to 128 characters',
      { details: { field: 'displayName', maxLength: PERSONA_DISPLAY_NAME_MAX_LENGTH } },
    );
  }
  if (value !== value.trim()) {
    throw new RuntimeError(
      'invalid_argument',
      'displayName must not have leading or trailing whitespace',
      { details: { field: 'displayName' } },
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      throw new RuntimeError(
        'invalid_argument',
        'displayName must not contain control characters',
        {
          details: { field: 'displayName' },
        },
      );
    }
  }
}

function assertOptions(options: PersonaLifecycleOptions): void {
  if (typeof options !== 'object' || options === null) {
    throw new RuntimeError('invalid_argument', 'lifecycle options must be an object');
  }
  if (!(options.store instanceof Store)) {
    throw new RuntimeError('invalid_argument', 'store must be a Store', {
      details: { field: 'store' },
    });
  }
  if (!isBootId(options.bootId)) {
    throw new RuntimeError('invalid_argument', 'bootId must match the boot id pattern', {
      details: { field: 'bootId' },
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
  if (options.beforeCommit !== undefined && typeof options.beforeCommit !== 'function') {
    throw new RuntimeError('invalid_argument', 'beforeCommit must be a function', {
      details: { field: 'beforeCommit' },
    });
  }
  if (options.duringRead !== undefined && typeof options.duringRead !== 'function') {
    throw new RuntimeError('invalid_argument', 'duringRead must be a function', {
      details: { field: 'duringRead' },
    });
  }
  const logger: RuntimeLogger | undefined = options.logger;
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

function isThenable(value: unknown): value is Promise<void> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}
