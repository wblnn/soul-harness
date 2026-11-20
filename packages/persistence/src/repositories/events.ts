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
 *   4. `commitP1Envelope` inserts `received` and moves to the P1 outcome in the
 *      same commit. Archive columns stay at their defaults. It is not an
 *      Archive Writer and it does not store a body.
 *   5. `expireActive` is the same persona-scoped guard as `expireIfActive`,
 *      with the caller naming which expired reason to write. Terminal rows and
 *      non-`none` archive states are left untouched.
 */

import {
  isAdapterEventRef,
  isAdapterId,
  isEventId,
  isExpiredReason,
  isPersonaId,
  isRejectedReason,
  isSessionId,
  isSourceId,
} from '@soul-harness/contracts';
import type {
  AdapterId,
  AttentionOutcome,
  EventId,
  EventStatus,
  ExpiredReason,
  PersonaId,
  RejectedReason,
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
 * P1 envelope commit.
 *
 * `outcome` is the status that is visible after commit. The statement inserts
 * `received` and then updates that same row before COMMIT, so a crash cannot
 * observe the intermediate status and cannot observe `pending`. Archive
 * columns are not in either statement.
 */
export type P1CommitOutcome =
  | { readonly status: 'accepted' }
  | { readonly status: 'expired'; readonly reason: 'queue_overflow' };

export interface CommitP1EventInput {
  readonly id: EventId;
  readonly personaId: PersonaId;
  readonly sessionId?: SessionId | null;
  readonly source: SourceId;
  readonly adapterId: AdapterId;
  readonly adapterEventRef: string;
  readonly receivedAt: number;
  readonly occurredAt?: number | null;
  readonly updatedAt: number;
  readonly outcome: P1CommitOutcome;
}

/**
 * Conditional close of a still-active P1 event (`archive_state = 'none'`).
 *
 * Same row guard as `expireIfActive`. `reason` chooses the expired code.
 * `buffer_lost` remains available through `expireIfActive`; this method is how
 * a live process records `ttl_expired` or `queue_overflow` without rewriting a
 * terminal row.
 */
export interface ExpireActiveEventInput {
  readonly id: EventId;
  readonly personaId: PersonaId;
  readonly updatedAt: number;
  readonly reason: ExpiredReason;
}

/**
 * Conditional close of a still-active P1 event to `rejected`.
 *
 * Same row guard as `expireActive`. `reason` is a rejection code, not an
 * expiry code. `buffer_lost` stays on `expireIfActive` and is not accepted here.
 */
export interface RejectActiveEventInput {
  readonly id: EventId;
  readonly personaId: PersonaId;
  readonly updatedAt: number;
  readonly reason: RejectedReason;
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

function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PersistenceError('invalid_argument', `${field} must be a non-negative safe integer`, {
      details: { field },
    });
  }
}

function assertCommitInput(input: CommitP1EventInput): {
  readonly status: 'accepted' | 'expired';
  readonly reason: StatusReason | null;
} {
  if (!isEventId(input.id)) {
    throw new PersistenceError('invalid_identifier', 'event id must be a valid EventId', {
      details: { field: 'id' },
    });
  }
  assertPersonaId(input.personaId);
  if (input.sessionId !== undefined && input.sessionId !== null && !isSessionId(input.sessionId)) {
    throw new PersistenceError('invalid_identifier', 'sessionId must be a valid SessionId', {
      details: { field: 'sessionId' },
    });
  }
  if (!isSourceId(input.source)) {
    throw new PersistenceError('invalid_identifier', 'source must be a valid source id', {
      details: { field: 'source' },
    });
  }
  if (!isAdapterId(input.adapterId)) {
    throw new PersistenceError('invalid_identifier', 'adapterId must be a valid adapter id', {
      details: { field: 'adapterId' },
    });
  }
  if (!isAdapterEventRef(input.adapterEventRef)) {
    throw new PersistenceError(
      'invalid_identifier',
      'adapterEventRef must match ^[A-Za-z0-9._:-]{1,64}$',
      { details: { field: 'adapterEventRef' } },
    );
  }
  assertTimestamp(input.receivedAt, 'receivedAt');
  assertTimestamp(input.updatedAt, 'updatedAt');
  if (input.occurredAt !== undefined && input.occurredAt !== null) {
    assertTimestamp(input.occurredAt, 'occurredAt');
  }
  if (input.outcome.status === 'accepted') {
    return { status: 'accepted', reason: null };
  }
  if (input.outcome.status === 'expired' && input.outcome.reason === 'queue_overflow') {
    return { status: 'expired', reason: 'queue_overflow' };
  }
  throw new PersistenceError(
    'invalid_argument',
    'P1 commit outcome must be accepted or expired queue_overflow',
    { details: { field: 'outcome' } },
  );
}

function assertExpireActiveInput(input: ExpireActiveEventInput): void {
  if (!isEventId(input.id)) {
    throw new PersistenceError('invalid_identifier', 'event id must be a valid EventId', {
      details: { field: 'id' },
    });
  }
  assertPersonaId(input.personaId);
  assertTimestamp(input.updatedAt, 'updatedAt');
  if (!isExpiredReason(input.reason)) {
    throw new PersistenceError('invalid_argument', 'reason must be an expired status reason', {
      details: { field: 'reason' },
    });
  }
}

function assertRejectActiveInput(input: RejectActiveEventInput): void {
  if (!isEventId(input.id)) {
    throw new PersistenceError('invalid_identifier', 'event id must be a valid EventId', {
      details: { field: 'id' },
    });
  }
  assertPersonaId(input.personaId);
  assertTimestamp(input.updatedAt, 'updatedAt');
  if (!isRejectedReason(input.reason)) {
    throw new PersistenceError('invalid_argument', 'reason must be a rejected status reason', {
      details: { field: 'reason' },
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

    /**
     * Inserts a P1 envelope as `received` and moves it to `outcome` before commit.
     *
     * Archive columns are omitted, so they stay NULL / NULL / `'none'`. The
     * body is not a parameter. A dedupe-key or primary-key conflict throws
     * `unique_conflict` and leaves the database unchanged.
     */
    commitP1Envelope(input: CommitP1EventInput): EventRow {
      const outcome = assertCommitInput(input);

      return withWrite(store, (tx) => {
        tx.prepare(
          `INSERT INTO events
             (id, persona_id, session_id, source, adapter_id, adapter_event_ref, status,
              attention_outcome, salience, summary, received_at, occurred_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'received', NULL, 0, NULL, ?, ?, ?)`,
        ).run(
          input.id,
          input.personaId,
          input.sessionId ?? null,
          input.source,
          input.adapterId,
          input.adapterEventRef,
          input.receivedAt,
          input.occurredAt ?? null,
          input.updatedAt,
        );

        const changes = tx
          .prepare(
            `UPDATE events
                SET status = ?, status_reason = ?, updated_at = ?
              WHERE id = ? AND status = 'received' AND archive_state = 'none'`,
          )
          .run(outcome.status, outcome.reason, input.updatedAt, input.id).changes;

        if (Number(changes) !== 1) {
          throw new PersistenceError(
            'db_error',
            'P1 envelope commit did not move the inserted row',
            { details: { operation: 'commit P1 envelope' } },
          );
        }

        const written = selectById(tx, input.id);
        if (written === null) {
          throw new Error('event commit did not produce a row');
        }
        return written;
      });
    },

    /**
     * Moves a still-active P1 event to `expired` with the given reason.
     *
     * The guard matches `expireIfActive`: persona scope, active status, and
     * `archive_state = 'none'`. A miss returns null and writes nothing.
     * `attention_outcome` is not in the SET list.
     */
    expireActive(input: ExpireActiveEventInput): EventRow | null {
      assertExpireActiveInput(input);

      return withWrite(store, (tx) => {
        const changes = tx
          .prepare(
            `UPDATE events
                SET status = 'expired', status_reason = ?, updated_at = ?
              WHERE persona_id = ? AND id = ? AND status IN ('received', 'accepted')
                AND archive_state = 'none'`,
          )
          .run(input.reason, input.updatedAt, input.personaId, input.id).changes;

        return Number(changes) === 0 ? null : selectById(tx, input.id);
      });
    },

    /**
     * Moves a still-active P1 event to `rejected` with a controlled reason.
     *
     * Same guard as `expireActive`: persona scope, `received` or `accepted`,
     * and `archive_state = 'none'`. It does not write `buffer_lost`. A miss
     * returns null. `attention_outcome` stays as it was.
     */
    rejectIfActive(input: RejectActiveEventInput): EventRow | null {
      assertRejectActiveInput(input);

      return withWrite(store, (tx) => {
        const changes = tx
          .prepare(
            `UPDATE events
                SET status = 'rejected', status_reason = ?, updated_at = ?
              WHERE persona_id = ? AND id = ? AND status IN ('received', 'accepted')
                AND archive_state = 'none'`,
          )
          .run(input.reason, input.updatedAt, input.personaId, input.id).changes;

        return Number(changes) === 0 ? null : selectById(tx, input.id);
      });
    },
  };
}

export type EventRepository = ReturnType<typeof createEventRepository>;
