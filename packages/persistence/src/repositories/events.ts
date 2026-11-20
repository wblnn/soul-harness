/**
 * events repository.
 *
 * Invariants encoded structurally:
 *   1. `insert` cannot set any archive column. In P1 there is no Archive Writer,
 *      so `archive_ref` / `archive_disposition` must stay NULL and
 *      `archive_state` must stay 'none' (DATA-MODEL §2.1, PLAN §6.3).
 *   2. The dedupe key lookup uses the unique index
 *      `(persona_id, adapter_id, source, adapter_event_ref)` rather than a scan.
 *   3. `expireIfActive` addresses an event only together with `personaId`, and
 *      only while `archive_state` is still `'none'` (P1 buffer-loss). It does
 *      not implement archive recovery (scan A / scan B).
 */

import { isAdapterEventRef, isEventId, isPersonaId } from '@soul-harness/contracts';
import type {
  AdapterId,
  AttentionOutcome,
  EventId,
  EventStatus,
  PersonaId,
  SessionId,
  SourceId,
  StatusReason,
  ArchiveDisposition,
  ArchiveRef,
  ArchiveState,
} from '@soul-harness/contracts';

import { allRows, oneRow, type StatementSource } from '../db/rows.js';
import { readDatabaseOf } from '../db/read.js';
import type { Store } from '../db/store.js';
import { PersistenceError } from '../errors.js';
import { camelizeRow } from '../mapping.js';
import { withWrite } from '../tx/coordinator.js';
import type { EventRow } from '../types/rows.js';
import { assertLimit } from './shared.js';

const COLUMNS = [
  'id',
  'persona_id',
  'session_id',
  'source',
  'adapter_id',
  'adapter_event_ref',
  'status',
  'attention_outcome',
  'salience',
  'summary',
  'archive_ref',
  'received_at',
  'occurred_at',
  'updated_at',
  'archive_disposition',
  'archive_state',
  'status_reason',
].join(', ');

export interface InsertEventInput {
  readonly id: EventId;
  readonly personaId: PersonaId;
  readonly sessionId?: SessionId | null;
  readonly source: SourceId;
  readonly adapterId: AdapterId;
  readonly adapterEventRef: string;
  readonly status: EventStatus;
  readonly attentionOutcome?: AttentionOutcome | null;
  readonly salience?: number;
  /**
   * P1 stores no summary at all (DATA-MODEL §3.1): the column may only be NULL.
   * The type carries that restriction, and `assertInsertInput` re-checks it at
   * runtime because JavaScript callers bypass the type.
   */
  readonly summary?: null;
  readonly receivedAt: number;
  readonly occurredAt?: number | null;
  readonly updatedAt: number;
}

/**
 * Rejects anything the database would accept but the data model forbids.
 *
 * Both checks run BEFORE the write transaction opens, so a rejected call leaves
 * the database untouched.
 */
function assertInsertInput(input: InsertEventInput): void {
  if (input.summary !== undefined && input.summary !== null) {
    throw new PersistenceError(
      'invalid_column_value',
      'events.summary must be NULL in P1; summaries are content, not metadata',
      { details: { column: 'summary' } },
    );
  }
  if (!isAdapterEventRef(input.adapterEventRef)) {
    throw new PersistenceError(
      'invalid_identifier',
      'adapterEventRef must match ^[A-Za-z0-9._:-]{1,64}$',
      { details: { field: 'adapterEventRef' } },
    );
  }
}

export interface UpdateEventStatusInput {
  readonly id: EventId;
  readonly status: EventStatus;
  /** Must be non-null exactly for the terminal statuses (DATA-MODEL §3.4). */
  readonly statusReason: StatusReason | null;
  readonly attentionOutcome: AttentionOutcome | null;
  readonly updatedAt: number;
}

/**
 * P1 buffer-loss recovery only (`archive_state = 'none'`).
 *
 * `personaId` is required scope, not an optional filter (IDENTITY-PROTOCOL §1
 * rule 5). This input does not describe archive recovery (scan A / scan B).
 */
export interface ExpireEventInput {
  readonly id: EventId;
  readonly personaId: PersonaId;
  readonly updatedAt: number;
}

/**
 * Rejects a scope that cannot be a persona id before any database access.
 *
 * Identifier shape uses `invalid_identifier` (same code as `adapterEventRef`).
 * Pagination cursors stay on `invalid_argument`. JavaScript callers bypass the
 * brand, so the check runs before the write transaction opens.
 */
function assertPersonaId(personaId: PersonaId): void {
  if (!isPersonaId(personaId)) {
    throw new PersistenceError('invalid_identifier', 'personaId must be a valid PersonaId', {
      details: { field: 'personaId' },
    });
  }
}

/**
 * Rejects a cursor that cannot be an event id before any database access.
 *
 * Validation runs first so a malformed cursor never reaches the SQL layer.
 */
function assertAfterId(afterId: EventId | undefined): void {
  if (afterId !== undefined && !isEventId(afterId)) {
    throw new PersistenceError('invalid_argument', 'afterId must be a valid EventId', {
      details: { field: 'afterId' },
    });
  }
}

function mapEvent(raw: Readonly<Record<string, unknown>>): EventRow {
  const row = camelizeRow<Record<string, unknown>>(raw);
  return {
    id: row['id'] as EventId,
    personaId: row['personaId'] as PersonaId,
    sessionId: (row['sessionId'] as SessionId | null) ?? null,
    source: row['source'] as SourceId,
    adapterId: row['adapterId'] as AdapterId,
    adapterEventRef: row['adapterEventRef'] as string,
    status: row['status'] as EventStatus,
    attentionOutcome: (row['attentionOutcome'] as AttentionOutcome | null) ?? null,
    salience: Number(row['salience']),
    summary: (row['summary'] as string | null) ?? null,
    archiveRef: (row['archiveRef'] as ArchiveRef | null) ?? null,
    receivedAt: Number(row['receivedAt']),
    occurredAt: row['occurredAt'] === null ? null : Number(row['occurredAt']),
    updatedAt: Number(row['updatedAt']),
    archiveDisposition: (row['archiveDisposition'] as ArchiveDisposition | null) ?? null,
    archiveState: row['archiveState'] as ArchiveState,
    statusReason: (row['statusReason'] as StatusReason | null) ?? null,
  };
}

function selectById(source: StatementSource, id: EventId): EventRow | null {
  const raw = oneRow<Record<string, unknown>>(
    source.prepare(`SELECT ${COLUMNS} FROM events WHERE id = ?`),
    id,
  );
  return raw === undefined ? null : mapEvent(raw);
}

export function createEventRepository(store: Store) {
  return {
    insert(input: InsertEventInput): EventRow {
      assertInsertInput(input);

      return withWrite(store, (tx) => {
        // Archive columns are intentionally absent: P1 has no Archive Writer.
        tx.prepare(
          `INSERT INTO events
             (id, persona_id, session_id, source, adapter_id, adapter_event_ref, status,
              attention_outcome, salience, summary, received_at, occurred_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.id,
          input.personaId,
          input.sessionId ?? null,
          input.source,
          input.adapterId,
          input.adapterEventRef,
          input.status,
          input.attentionOutcome ?? null,
          input.salience ?? 0,
          input.summary ?? null,
          input.receivedAt,
          input.occurredAt ?? null,
          input.updatedAt,
        );

        const created = selectById(tx, input.id);
        // Unreachable in practice: the row was inserted in this transaction.
        if (created === null) {
          throw new Error('event insert did not produce a row');
        }
        return created;
      });
    },

    getById(id: EventId): EventRow | null {
      return selectById(readDatabaseOf(store), id);
    },

    /** Uses `ux_events_dedupe`; returns the existing event for the same stimulus. */
    findByDedupeKey(input: {
      readonly personaId: PersonaId;
      readonly adapterId: AdapterId;
      readonly source: SourceId;
      readonly adapterEventRef: string;
    }): EventRow | null {
      const raw = oneRow<Record<string, unknown>>(
        readDatabaseOf(store).prepare(
          `SELECT ${COLUMNS} FROM events
           WHERE persona_id = ? AND adapter_id = ? AND source = ? AND adapter_event_ref = ?
           LIMIT 1`,
        ),
        input.personaId,
        input.adapterId,
        input.source,
        input.adapterEventRef,
      );
      return raw === undefined ? null : mapEvent(raw);
    },

    /** Returns the updated row, or null when no event has that id. */
    updateStatus(input: UpdateEventStatusInput): EventRow | null {
      return withWrite(store, (tx) => {
        const changes = tx
          .prepare(
            `UPDATE events
             SET status = ?, status_reason = ?, attention_outcome = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            input.status,
            input.statusReason,
            input.attentionOutcome,
            input.updatedAt,
            input.id,
          ).changes;

        return Number(changes) === 0 ? null : selectById(tx, input.id);
      });
    },

    /** Uses `ix_events_persona_status`. */
    listByPersonaStatus(input: {
      readonly personaId: PersonaId;
      readonly status: EventStatus;
      readonly limit?: number;
    }): readonly EventRow[] {
      const bounded = assertLimit(input.limit);
      const rows = allRows<Record<string, unknown>>(
        readDatabaseOf(store).prepare(
          `SELECT ${COLUMNS} FROM events
           WHERE persona_id = ? AND status = ?
           ORDER BY received_at DESC LIMIT ?`,
        ),
        input.personaId,
        input.status,
        bounded,
      );
      return rows.map(mapEvent);
    },

    /**
     * Keyset page ordered by primary key, filtered to one persona and one status.
     *
     * Same contract as `personas.listPage`: the cursor and the ORDER BY both use
     * `id`, so paging cannot skip or repeat rows; callers stop when the page is
     * shorter than `limit`. The ordering differs from `listByPersonaStatus`,
     * which sorts by `received_at` (not unique) and is therefore not pageable.
     */
    listPageByPersonaStatus(input: {
      readonly personaId: PersonaId;
      readonly status: EventStatus;
      readonly afterId?: EventId;
      readonly limit?: number;
    }): readonly EventRow[] {
      const bounded = assertLimit(input.limit);
      assertAfterId(input.afterId);

      const db = readDatabaseOf(store);
      const rows =
        input.afterId === undefined
          ? allRows<Record<string, unknown>>(
              db.prepare(
                `SELECT ${COLUMNS} FROM events
                 WHERE persona_id = ? AND status = ?
                 ORDER BY id ASC LIMIT ?`,
              ),
              input.personaId,
              input.status,
              bounded,
            )
          : allRows<Record<string, unknown>>(
              db.prepare(
                `SELECT ${COLUMNS} FROM events
                 WHERE persona_id = ? AND status = ? AND id > ?
                 ORDER BY id ASC LIMIT ?`,
              ),
              input.personaId,
              input.status,
              input.afterId,
              bounded,
            );

      return rows.map(mapEvent);
    },

    /**
     * Atomically moves a P1 buffer-loss event to `expired` / `buffer_lost`.
     *
     * Strictly that recovery. The WHERE clause requires all of: `persona_id`
     * (IDENTITY-PROTOCOL §1 rule 5 — persona data is never addressed by id
     * alone), `status IN ('received', 'accepted')`, and `archive_state = 'none'`.
     *
     * It does not handle archive recovery. Scan A (`archive_state = 'pending'`)
     * and scan B (`archive_state = 'failed'`, and any other non-`'none'` state)
     * need their archive state reconciled; this UPDATE will not touch them.
     *
     * The guard is part of the same UPDATE, so it cannot be raced. A miss
     * returns `null` having written nothing. `attention_outcome` is not in the
     * SET list and stays as it was.
     */
    expireIfActive(input: ExpireEventInput): EventRow | null {
      assertPersonaId(input.personaId);

      return withWrite(store, (tx) => {
        const changes = tx
          .prepare(
            `UPDATE events
                SET status = 'expired', status_reason = 'buffer_lost', updated_at = ?
              WHERE persona_id = ? AND id = ? AND status IN ('received', 'accepted')
                AND archive_state = 'none'`,
          )
          .run(input.updatedAt, input.personaId, input.id).changes;

        return Number(changes) === 0 ? null : selectById(tx, input.id);
      });
    },
  };
}

export type EventRepository = ReturnType<typeof createEventRepository>;
