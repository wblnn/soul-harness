/**
 * sessions repository.
 *
 * The partial unique index `ux_sessions_external ... WHERE closed_at IS NULL`
 * means a re-opened external session gets a NEW id: closing the old row frees
 * the mapping. `close` therefore matches only a still-open row.
 *
 * `openActive` is the atomic form of that rule: it returns the still-open row
 * or inserts a new id. It never updates `closed_at`, so a closed window cannot
 * be revived. A unique conflict on the partial index re-reads the winner.
 */

import { isAdapterId, isPersonaId, isSessionId } from '@soul-harness/contracts';
import type { AdapterId, JsonObject, PersonaId, SessionId } from '@soul-harness/contracts';

import { allRows, oneRow, type StatementSource } from '../db/rows.js';
import { readDatabaseOf } from '../db/read.js';
import type { Store } from '../db/store.js';
import { PersistenceError } from '../errors.js';
import { camelizeRow } from '../mapping.js';
import { withWrite } from '../tx/coordinator.js';
import type { SessionRow } from '../types/rows.js';
import { JSON_SCHEMA_IDS, assertLimit, decodeOptionalJson, encodeOptionalJson } from './shared.js';

/**
 * Upper bound for an adapter-supplied session reference stored by `openActive`.
 *
 * The column itself has no CHECK. This limit keeps the mapping key from being
 * used as a place to store a message body. `insert` is unchanged.
 */
export const ACTIVE_SESSION_EXTERNAL_ID_MAX_LENGTH = 256;

const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

const COLUMNS = 'id, persona_id, adapter_id, external_id, opened_at, closed_at, meta_json';

export interface InsertSessionInput {
  readonly id: SessionId;
  readonly personaId: PersonaId;
  readonly adapterId: AdapterId;
  readonly externalId?: string | null;
  readonly openedAt: number;
  readonly metaJson?: JsonObject | null;
}

export interface CloseSessionInput {
  readonly id: SessionId;
  readonly closedAt: number;
}

/** Candidate id is used only when no open mapping exists. */
export interface OpenActiveSessionInput {
  readonly id: SessionId;
  readonly personaId: PersonaId;
  readonly adapterId: AdapterId;
  readonly externalId: string;
  readonly openedAt: number;
}

export interface OpenActiveSessionResult {
  readonly session: SessionRow;
  readonly created: boolean;
}

function assertOpenActiveInput(input: OpenActiveSessionInput): void {
  if (!isSessionId(input.id)) {
    throw new PersistenceError('invalid_identifier', 'session id must be a valid SessionId', {
      details: { field: 'id' },
    });
  }
  if (!isPersonaId(input.personaId)) {
    throw new PersistenceError('invalid_identifier', 'personaId must be a valid PersonaId', {
      details: { field: 'personaId' },
    });
  }
  if (!isAdapterId(input.adapterId)) {
    throw new PersistenceError('invalid_identifier', 'adapterId must be a valid adapter id', {
      details: { field: 'adapterId' },
    });
  }
  if (!Number.isSafeInteger(input.openedAt) || input.openedAt < 0) {
    throw new PersistenceError('invalid_argument', 'openedAt must be a non-negative safe integer', {
      details: { field: 'openedAt' },
    });
  }
  if (
    typeof input.externalId !== 'string' ||
    input.externalId.length < 1 ||
    input.externalId.length > ACTIVE_SESSION_EXTERNAL_ID_MAX_LENGTH ||
    input.externalId !== input.externalId.trim()
  ) {
    throw new PersistenceError(
      'invalid_argument',
      'externalId must be a trimmed string of 1 to 256 characters',
      { details: { field: 'externalId', maxLength: ACTIVE_SESSION_EXTERNAL_ID_MAX_LENGTH } },
    );
  }
  for (let index = 0; index < input.externalId.length; index += 1) {
    const code = input.externalId.charCodeAt(index);
    if (code <= 32 || code === 127) {
      throw new PersistenceError(
        'invalid_argument',
        'externalId must not contain whitespace or control characters',
        { details: { field: 'externalId' } },
      );
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { errcode?: unknown }).errcode;
  return code === SQLITE_CONSTRAINT_PRIMARYKEY || code === SQLITE_CONSTRAINT_UNIQUE;
}

function mapSession(raw: Readonly<Record<string, unknown>>): SessionRow {
  const row = camelizeRow<Record<string, unknown>>(raw);
  return {
    id: row['id'] as SessionId,
    personaId: row['personaId'] as PersonaId,
    adapterId: row['adapterId'] as AdapterId,
    externalId: (row['externalId'] as string | null) ?? null,
    openedAt: Number(row['openedAt']),
    closedAt: row['closedAt'] === null ? null : Number(row['closedAt']),
    metaJson: decodeOptionalJson('meta_json', JSON_SCHEMA_IDS.sessionMeta, row['metaJson']),
  };
}

function selectById(source: StatementSource, id: SessionId): SessionRow | null {
  const raw = oneRow<Record<string, unknown>>(
    source.prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`),
    id,
  );
  return raw === undefined ? null : mapSession(raw);
}

function selectActive(
  source: StatementSource,
  input: {
    readonly personaId: PersonaId;
    readonly adapterId: AdapterId;
    readonly externalId: string;
  },
): SessionRow | null {
  const raw = oneRow<Record<string, unknown>>(
    source.prepare(
      `SELECT ${COLUMNS} FROM sessions
       WHERE persona_id = ? AND adapter_id = ? AND external_id = ? AND closed_at IS NULL
       LIMIT 1`,
    ),
    input.personaId,
    input.adapterId,
    input.externalId,
  );
  return raw === undefined ? null : mapSession(raw);
}

export function createSessionRepository(store: Store) {
  return {
    insert(input: InsertSessionInput): SessionRow {
      return withWrite(store, (tx) => {
        tx.prepare(
          `INSERT INTO sessions (id, persona_id, adapter_id, external_id, opened_at, meta_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          input.id,
          input.personaId,
          input.adapterId,
          input.externalId ?? null,
          input.openedAt,
          encodeOptionalJson(JSON_SCHEMA_IDS.sessionMeta, input.metaJson),
        );

        const created = selectById(tx, input.id);
        // Unreachable in practice: the row was inserted in this transaction.
        if (created === null) {
          throw new Error('session insert did not produce a row');
        }
        return created;
      });
    },

    getById(id: SessionId): SessionRow | null {
      return selectById(readDatabaseOf(store), id);
    },

    /** Looks up the still-open mapping for an adapter-side reference. */
    findActiveByExternal(input: {
      readonly personaId: PersonaId;
      readonly adapterId: AdapterId;
      readonly externalId: string;
    }): SessionRow | null {
      return selectActive(readDatabaseOf(store), input);
    },

    /**
     * Returns the open mapping, or inserts `id` when none is open.
     *
     * A closed row is not updated. If the insert loses the partial unique
     * index, the open row that won is returned instead. A primary-key conflict
     * with no open mapping is rethrown so the caller can allocate a new id.
     */
    openActive(input: OpenActiveSessionInput): OpenActiveSessionResult {
      assertOpenActiveInput(input);

      return withWrite(store, (tx) => {
        const existing = selectActive(tx, input);
        if (existing !== null) {
          return { session: existing, created: false };
        }

        try {
          tx.prepare(
            `INSERT INTO sessions (id, persona_id, adapter_id, external_id, opened_at, meta_json)
             VALUES (?, ?, ?, ?, ?, NULL)`,
          ).run(input.id, input.personaId, input.adapterId, input.externalId, input.openedAt);
        } catch (error) {
          if (!isUniqueViolation(error)) {
            throw error;
          }
          const winner = selectActive(tx, input);
          if (winner !== null) {
            return { session: winner, created: false };
          }
          throw error;
        }

        const created = selectById(tx, input.id);
        if (created === null) {
          throw new Error('session insert did not produce a row');
        }
        return { session: created, created: true };
      });
    },

    /** Closes an open session. Returns false when it was already closed. */
    close(input: CloseSessionInput): boolean {
      return withWrite(store, (tx) => {
        const changes = tx
          .prepare('UPDATE sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL')
          .run(input.closedAt, input.id).changes;
        return Number(changes) > 0;
      });
    },

    listByPersona(personaId: PersonaId, limit?: number): readonly SessionRow[] {
      const bounded = assertLimit(limit);
      const rows = allRows<Record<string, unknown>>(
        readDatabaseOf(store).prepare(
          `SELECT ${COLUMNS} FROM sessions WHERE persona_id = ? ORDER BY opened_at DESC LIMIT ?`,
        ),
        personaId,
        bounded,
      );
      return rows.map(mapSession);
    },
  };
}

export type SessionRepository = ReturnType<typeof createSessionRepository>;
