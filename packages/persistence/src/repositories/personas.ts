/**
 * personas repository.
 *
 * `version` is bumped by the database statement (DATA-MODEL §1 / §6: every
 * committed change increments it); the repository never accepts a version from
 * the caller, so it cannot be spoofed.
 */

import { isBootId, isPersonaId } from '@soul-harness/contracts';
import type { BootId, PersonaId } from '@soul-harness/contracts';

import { allRows, oneRow, type StatementSource } from '../db/rows.js';
import { readDatabaseOf } from '../db/read.js';
import type { Store } from '../db/store.js';
import { PersistenceError } from '../errors.js';
import { camelizeRow } from '../mapping.js';
import { withWrite } from '../tx/coordinator.js';
import {
  PERSONA_STATES,
  type PersonaRow,
  type PersonaState,
  type RuntimeStateRow,
} from '../types/rows.js';
import { assertLimit } from './shared.js';

const COLUMNS = 'id, display_name, state, version, epoch, boot_id, created_at, updated_at';

const RUNTIME_COLUMNS = 'persona_id, state, boot_id, epoch, updated_at';

export interface InsertPersonaInput {
  readonly id: PersonaId;
  readonly displayName: string;
  readonly state: PersonaState;
  readonly bootId?: BootId | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface UpdatePersonaStateInput {
  readonly id: PersonaId;
  readonly state: PersonaState;
  readonly updatedAt: number;
}

/** Keyset page request; `afterId` is the last id of the previous page. */
export interface ListPersonaPageInput {
  readonly afterId?: PersonaId;
  readonly limit?: number;
}

/** Compare-and-set request: both expectations must hold or nothing is written. */
export interface CompareAndSetPersonaStateInput {
  readonly id: PersonaId;
  readonly expectedState: PersonaState;
  readonly expectedVersion: number;
  readonly nextState: PersonaState;
  readonly updatedAt: number;
}

/**
 * Conditional lifecycle write.
 *
 * This is storage, not policy: the caller decides whether `expectedState` may
 * become `nextState`. The statement only commits when both expectations still
 * match, then mirrors the resulting persona row onto `runtime_state` in the
 * same transaction. `epoch` is copied from the persona row; the caller cannot
 * supply one. `checkpoint_json` is not in either statement.
 *
 * `bootId` omitted (or `undefined`) leaves `personas.boot_id` as it is.
 * `bootId: null` clears it. A `BootId` replaces it. The mirrored runtime row
 * always receives the persona's boot id after that choice.
 */
export interface CommitPersonaLifecycleInput {
  readonly id: PersonaId;
  readonly expectedState: PersonaState;
  readonly expectedVersion: number;
  readonly nextState: PersonaState;
  readonly updatedAt: number;
  readonly bootId?: BootId | null;
}

/** Persona row and the runtime row written by the same lifecycle statement. */
export interface CommittedPersonaLifecycle {
  readonly persona: PersonaRow;
  readonly runtimeState: RuntimeStateRow;
}

/**
 * Rejects a cursor that cannot be a persona id before any database access.
 *
 * Validation runs first so a malformed cursor never reaches the SQL layer and
 * never depends on store state.
 */
function assertAfterId(afterId: PersonaId | undefined): void {
  if (afterId !== undefined && !isPersonaId(afterId)) {
    throw new PersistenceError('invalid_argument', 'afterId must be a valid PersonaId', {
      details: { field: 'afterId' },
    });
  }
}

function mapPersona(raw: Readonly<Record<string, unknown>>): PersonaRow {
  const row = camelizeRow<Record<string, unknown>>(raw);
  return {
    id: row['id'] as PersonaId,
    displayName: row['displayName'] as string,
    state: row['state'] as PersonaState,
    version: Number(row['version']),
    epoch: Number(row['epoch']),
    bootId: (row['bootId'] as BootId | null) ?? null,
    createdAt: Number(row['createdAt']),
    updatedAt: Number(row['updatedAt']),
  };
}

function selectById(source: StatementSource, id: PersonaId): PersonaRow | null {
  const raw = oneRow<Record<string, unknown>>(
    source.prepare(`SELECT ${COLUMNS} FROM personas WHERE id = ?`),
    id,
  );
  return raw === undefined ? null : mapPersona(raw);
}

function mapRuntimeState(raw: Readonly<Record<string, unknown>>): RuntimeStateRow {
  const row = camelizeRow<Record<string, unknown>>(raw);
  return {
    personaId: row['personaId'] as PersonaId,
    state: row['state'] as string,
    bootId: (row['bootId'] as BootId | null) ?? null,
    epoch: Number(row['epoch']),
    updatedAt: Number(row['updatedAt']),
  };
}

function selectRuntimeState(source: StatementSource, personaId: PersonaId): RuntimeStateRow | null {
  const raw = oneRow<Record<string, unknown>>(
    source.prepare(`SELECT ${RUNTIME_COLUMNS} FROM runtime_state WHERE persona_id = ?`),
    personaId,
  );
  return raw === undefined ? null : mapRuntimeState(raw);
}

/**
 * Copies the persona's lifecycle columns onto `runtime_state`.
 *
 * `epoch` comes from the persona row that was just written, so this cannot
 * increment it. `checkpoint_json` is absent from both the insert list and the
 * conflict update, so an existing checkpoint survives.
 */
function mirrorRuntimeState(source: StatementSource, persona: PersonaRow): RuntimeStateRow {
  source
    .prepare(
      `INSERT INTO runtime_state (persona_id, state, boot_id, epoch, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(persona_id) DO UPDATE SET
         state = excluded.state,
         boot_id = excluded.boot_id,
         epoch = excluded.epoch,
         updated_at = excluded.updated_at`,
    )
    .run(persona.id, persona.state, persona.bootId, persona.epoch, persona.updatedAt);

  const mirrored = selectRuntimeState(source, persona.id);
  // Unreachable in practice: the upsert above wrote this primary key.
  if (mirrored === null) {
    throw new Error('runtime_state mirror did not produce a row');
  }
  return mirrored;
}

function assertPersonaId(id: PersonaId): void {
  if (!isPersonaId(id)) {
    throw new PersistenceError('invalid_identifier', 'id must be a valid PersonaId', {
      details: { field: 'id' },
    });
  }
}

function assertPersonaState(value: string, field: string): void {
  if (!(PERSONA_STATES as readonly string[]).includes(value)) {
    throw new PersistenceError('invalid_argument', `${field} must be a persona state`, {
      details: { field },
    });
  }
}

function assertSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new PersistenceError('invalid_argument', `${field} must be a safe integer`, {
      details: { field },
    });
  }
}

function assertBootId(bootId: BootId | null | undefined): void {
  if (bootId !== undefined && bootId !== null && !isBootId(bootId)) {
    throw new PersistenceError('invalid_identifier', 'bootId must be a valid BootId', {
      details: { field: 'bootId' },
    });
  }
}

function assertLifecycleInput(input: InsertPersonaInput): void {
  assertPersonaId(input.id);
  if (typeof input.displayName !== 'string') {
    throw new PersistenceError('invalid_argument', 'displayName must be a string', {
      details: { field: 'displayName' },
    });
  }
  assertPersonaState(input.state, 'state');
  assertSafeInteger(input.createdAt, 'createdAt');
  assertSafeInteger(input.updatedAt, 'updatedAt');
  assertBootId(input.bootId);
}

export function createPersonaRepository(store: Store) {
  return {
    insert(input: InsertPersonaInput): PersonaRow {
      return withWrite(store, (tx) => {
        tx.prepare(
          `INSERT INTO personas (id, display_name, state, boot_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          input.id,
          input.displayName,
          input.state,
          input.bootId ?? null,
          input.createdAt,
          input.updatedAt,
        );

        const created = selectById(tx, input.id);
        // Unreachable in practice: the row was inserted in this transaction.
        if (created === null) {
          throw new Error('persona insert did not produce a row');
        }
        return created;
      });
    },

    getById(id: PersonaId): PersonaRow | null {
      return selectById(readDatabaseOf(store), id);
    },

    /** Returns the updated row, or null when no persona has that id. */
    updateState(input: UpdatePersonaStateInput): PersonaRow | null {
      return withWrite(store, (tx) => {
        const changes = tx
          .prepare(
            'UPDATE personas SET state = ?, version = version + 1, updated_at = ? WHERE id = ?',
          )
          .run(input.state, input.updatedAt, input.id).changes;

        return Number(changes) === 0 ? null : selectById(tx, input.id);
      });
    },

    list(limit?: number): readonly PersonaRow[] {
      const bounded = assertLimit(limit);
      const rows = allRows<Record<string, unknown>>(
        readDatabaseOf(store).prepare(
          `SELECT ${COLUMNS} FROM personas ORDER BY created_at DESC LIMIT ?`,
        ),
        bounded,
      );
      return rows.map(mapPersona);
    },

    /**
     * Keyset page ordered by primary key.
     *
     * The cursor and the ORDER BY use the same value (`id`), which is unique and
     * unforgeable per row, so a page boundary can never skip or repeat a row.
     * Callers stop when fewer than `limit` rows come back. `list()` deliberately
     * sorts by `created_at` (not unique) and is therefore not pageable.
     */
    listPage(input: ListPersonaPageInput = {}): readonly PersonaRow[] {
      const bounded = assertLimit(input.limit);
      assertAfterId(input.afterId);

      const db = readDatabaseOf(store);
      const rows =
        input.afterId === undefined
          ? allRows<Record<string, unknown>>(
              db.prepare(`SELECT ${COLUMNS} FROM personas ORDER BY id ASC LIMIT ?`),
              bounded,
            )
          : allRows<Record<string, unknown>>(
              db.prepare(`SELECT ${COLUMNS} FROM personas WHERE id > ? ORDER BY id ASC LIMIT ?`),
              input.afterId,
              bounded,
            );

      return rows.map(mapPersona);
    },

    /**
     * Writes the next state only if both the state and the version still match.
     *
     * The comparison and the upgrade happen inside one statement, so a concurrent
     * state change cannot be overwritten. `version` is bumped by the statement
     * (INV-V: any committed state write increments it). Returns `null` when either
     * expectation fails — in that case nothing was written.
     */
    compareAndSetState(input: CompareAndSetPersonaStateInput): PersonaRow | null {
      return withWrite(store, (tx) => {
        const changes = tx
          .prepare(
            `UPDATE personas
                SET state = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND state = ? AND version = ?`,
          )
          .run(
            input.nextState,
            input.updatedAt,
            input.id,
            input.expectedState,
            input.expectedVersion,
          ).changes;

        return Number(changes) === 0 ? null : selectById(tx, input.id);
      });
    },

    /**
     * Inserts the persona and its `runtime_state` row in one transaction.
     *
     * `version` and `epoch` stay on the table defaults (0 and 1). The runtime
     * row copies the epoch the insert actually stored. No checkpoint is written.
     */
    insertWithRuntimeState(input: InsertPersonaInput): CommittedPersonaLifecycle {
      assertLifecycleInput(input);
      return withWrite(store, (tx) => {
        tx.prepare(
          `INSERT INTO personas (id, display_name, state, boot_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          input.id,
          input.displayName,
          input.state,
          input.bootId ?? null,
          input.createdAt,
          input.updatedAt,
        );

        const persona = selectById(tx, input.id);
        // Unreachable in practice: the row was inserted in this transaction.
        if (persona === null) {
          throw new Error('persona insert did not produce a row');
        }
        return { persona, runtimeState: mirrorRuntimeState(tx, persona) };
      });
    },

    /**
     * Compare-and-set the persona, then mirror it onto `runtime_state`.
     *
     * Returns `null` when the expected state or version no longer matches.
     * In that case neither table is modified. A match bumps `version` by exactly
     * one and copies the stored epoch; it does not add a way to set epoch.
     */
    commitLifecycle(input: CommitPersonaLifecycleInput): CommittedPersonaLifecycle | null {
      assertPersonaId(input.id);
      assertPersonaState(input.expectedState, 'expectedState');
      assertPersonaState(input.nextState, 'nextState');
      assertSafeInteger(input.expectedVersion, 'expectedVersion');
      if (input.expectedVersion < 0) {
        throw new PersistenceError(
          'invalid_argument',
          'expectedVersion must be a non-negative safe integer',
          { details: { field: 'expectedVersion' } },
        );
      }
      assertSafeInteger(input.updatedAt, 'updatedAt');
      assertBootId(input.bootId);

      return withWrite(store, (tx) => {
        const changes =
          input.bootId === undefined
            ? tx
                .prepare(
                  `UPDATE personas
                      SET state = ?, version = version + 1, updated_at = ?
                    WHERE id = ? AND state = ? AND version = ?`,
                )
                .run(
                  input.nextState,
                  input.updatedAt,
                  input.id,
                  input.expectedState,
                  input.expectedVersion,
                ).changes
            : tx
                .prepare(
                  `UPDATE personas
                      SET state = ?, version = version + 1, updated_at = ?, boot_id = ?
                    WHERE id = ? AND state = ? AND version = ?`,
                )
                .run(
                  input.nextState,
                  input.updatedAt,
                  input.bootId,
                  input.id,
                  input.expectedState,
                  input.expectedVersion,
                ).changes;

        if (Number(changes) === 0) {
          return null;
        }

        const persona = selectById(tx, input.id);
        // Unreachable in practice: the guarded update reported a changed row.
        if (persona === null) {
          throw new Error('persona commit did not produce a row');
        }
        return { persona, runtimeState: mirrorRuntimeState(tx, persona) };
      });
    },
  };
}

export type PersonaRepository = ReturnType<typeof createPersonaRepository>;
