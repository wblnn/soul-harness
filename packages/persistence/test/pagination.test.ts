/**
 * Keyset pagination: completeness, boundaries, and WAL snapshot behaviour.
 *
 * The snapshot cases (A5/A6 for personas, E6 for events) use **two real connections on the same file**:
 *
 *   1. open the read scope (`withRead` → `BEGIN DEFERRED`, no snapshot yet);
 *   2. fetch the first page — *this* SELECT establishes the snapshot;
 *   3. let the other connection commit an insert / delete;
 *   4. continue paging on the original connection.
 *
 * A later fresh snapshot proves the other connection's change really committed,
 * so "not visible" can never be explained by a failed write.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterId, EventId, EventStatus, PersonaId, SourceId } from '@soul-harness/contracts';

import { databaseOf } from '../src/db/store.js';
import { PersistenceError } from '../src/errors.js';
import { createPersonaRepository } from '../src/repositories/personas.js';
import { createRepositories, migrate, openStore, withRead, type Store } from '../src/index.js';
import { dbPathIn, makeTempDir, removeTempDir } from './helpers/temp.js';

const NOW = 1_731_700_000_000;
const BODY = '01JQ8Z3K5M7P9R2T4V6X8Z';

/** 22-char body + 4-digit suffix = the 26 chars a persona id requires. */
function pid(n: number): PersonaId {
  return `psn_${BODY}${String(n).padStart(4, '0')}` as PersonaId;
}

/** 12 ids, ten apart, so an insert can land exactly between two pages. */
const IDS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120].map(pid);
const INSERTED = pid(45);
const DELETED = pid(90);

interface Pair {
  readonly dir: string;
  readonly a: Store;
  readonly b: Store;
}

const pairs: Pair[] = [];

function openPair(): Pair {
  const dir = makeTempDir('sh-page-');
  const a = openStore({ file: dbPathIn(dir) });
  migrate(a);
  // A second connection on the same file, exactly what recovery tooling uses.
  const b = openStore({ file: dbPathIn(dir) });
  const pair = { dir, a, b };
  pairs.push(pair);
  return pair;
}

afterEach(() => {
  while (pairs.length > 0) {
    const pair = pairs.pop() as Pair;
    pair.b.close();
    pair.a.close();
    removeTempDir(pair.dir);
  }
});

function seed(store: Store, ids: readonly PersonaId[] = IDS): void {
  const { personas } = createRepositories(store);
  for (const id of ids) {
    personas.insert({
      id,
      displayName: `persona-${id.slice(-4)}`,
      state: 'STOPPED',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}

function idsOf(rows: readonly { readonly id: PersonaId }[]): PersonaId[] {
  return rows.map((row) => row.id);
}

const ADAPTER = 'qq' as AdapterId;
const SOURCE = 'qq' as SourceId;
const EVENT_PERSONA = pid(1);
const EVENT_OTHER = pid(2);

/** 22-char body + 4-digit suffix = the 26 chars an event id requires. */
function eid(n: number): EventId {
  return `evt_${BODY}${String(n).padStart(4, '0')}` as EventId;
}

function seedEventPersona(store: Store, id: PersonaId): void {
  createRepositories(store).personas.insert({
    id,
    displayName: `events-${id.slice(-4)}`,
    state: 'STOPPED',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function insertEvent(
  store: Store,
  input: {
    readonly id: EventId;
    readonly personaId: PersonaId;
    readonly status: EventStatus;
  },
): void {
  createRepositories(store).events.insert({
    id: input.id,
    personaId: input.personaId,
    source: SOURCE,
    adapterId: ADAPTER,
    adapterEventRef: input.id,
    status: input.status,
    receivedAt: NOW,
    updatedAt: NOW,
  });
}

/**
 * One transaction for a full-scan fixture. Rows use the same columns `insert`
 * writes; archive columns stay at the P1 defaults (`none` / NULL).
 */
function insertReceivedBulk(store: Store, personaId: PersonaId, ids: readonly EventId[]): void {
  const db = databaseOf(store);
  const statement = db.prepare(
    `INSERT INTO events
       (id, persona_id, source, adapter_id, adapter_event_ref, status, received_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'received', ?, ?)`,
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of ids) {
      statement.run(id, personaId, SOURCE, ADAPTER, id, NOW, NOW);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function eventIdsOf(rows: readonly { readonly id: EventId }[]): EventId[] {
  return rows.map((row) => row.id);
}

describe('personas.listPage', () => {
  it('A1 returns every row in id order when the table fits in one page', () => {
    const { a } = openPair();
    seed(a);

    const rows = createRepositories(a).personas.listPage({ limit: 50 });

    expect(idsOf(rows)).toStrictEqual(IDS);
    // Fewer rows than the limit is the end-of-scan signal.
    expect(rows.length).toBeLessThan(50);
  });

  it('A2 stops after a full page by returning an empty page', () => {
    const { a } = openPair();
    seed(a);
    const { personas } = createRepositories(a);

    const first = personas.listPage({ limit: IDS.length });
    expect(first).toHaveLength(IDS.length);
    expect(idsOf(first)).toStrictEqual(IDS);

    const second = personas.listPage({
      afterId: IDS[IDS.length - 1] as PersonaId,
      limit: IDS.length,
    });
    expect(second).toStrictEqual([]);
  });

  it('A3 pages across three pages without skipping or repeating', () => {
    const { a } = openPair();
    seed(a);
    const { personas } = createRepositories(a);

    const seen: PersonaId[] = [];
    let cursor: PersonaId | undefined;

    for (;;) {
      const page = personas.listPage(
        cursor === undefined ? { limit: 4 } : { afterId: cursor, limit: 4 },
      );
      if (page.length === 0) {
        break;
      }
      seen.push(...idsOf(page));
      expect(page.length).toBeLessThanOrEqual(4);
      cursor = page[page.length - 1]?.id;
      if (page.length < 4) {
        break;
      }
    }

    expect(seen).toStrictEqual(IDS);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('A4 returns an empty page for an empty table', () => {
    const { a } = openPair();

    expect(createRepositories(a).personas.listPage({ limit: 10 })).toStrictEqual([]);
  });

  it('A5 keeps the snapshot when another connection inserts between pages', () => {
    const pair = openPair();
    seed(pair.a);
    const reader = createRepositories(pair.a).personas;
    const writer = createRepositories(pair.b).personas;
    const collected: PersonaId[] = [];

    withRead(pair.a, () => {
      // 1. First page: this SELECT is what establishes the snapshot.
      const page1 = reader.listPage({ limit: 4 });
      expect(idsOf(page1)).toStrictEqual(IDS.slice(0, 4));

      // 2. Another connection commits a row that sorts between page 1 and page 2.
      writer.insert({
        id: INSERTED,
        displayName: 'inserted-between-pages',
        state: 'STOPPED',
        createdAt: NOW,
        updatedAt: NOW,
      });

      // 3. Page 2 must start at 0050, not at the newly inserted 0045.
      const page2 = reader.listPage({
        afterId: page1[page1.length - 1]?.id as PersonaId,
        limit: 4,
      });
      expect(idsOf(page2)).toStrictEqual(IDS.slice(4, 8));

      const page3 = reader.listPage({
        afterId: page2[page2.length - 1]?.id as PersonaId,
        limit: 4,
      });
      expect(idsOf(page3)).toStrictEqual(IDS.slice(8, 12));

      const page4 = reader.listPage({
        afterId: page3[page3.length - 1]?.id as PersonaId,
        limit: 4,
      });
      expect(page4).toStrictEqual([]);

      collected.push(...idsOf(page1), ...idsOf(page2), ...idsOf(page3));
    });

    // The scan saw the snapshot (12 rows), not the state at transaction end (13).
    expect(collected).toStrictEqual(IDS);
    expect(collected).not.toContain(INSERTED);

    // Control: a fresh snapshot does see the insert, so the write really committed.
    const fresh = withRead(pair.a, () => reader.listPage({ limit: 50 }));
    expect(fresh).toHaveLength(IDS.length + 1);
    expect(idsOf(fresh)).toContain(INSERTED);
  });

  it('A6 still returns a row deleted between pages by another connection', () => {
    const pair = openPair();
    seed(pair.a);
    const reader = createRepositories(pair.a).personas;
    const collected: PersonaId[] = [];

    withRead(pair.a, () => {
      const page1 = reader.listPage({ limit: 4 });
      expect(idsOf(page1)).toStrictEqual(IDS.slice(0, 4));

      // Delete a row that has NOT been read yet (it belongs to page 3).
      const removed = databaseOf(pair.b).prepare('DELETE FROM personas WHERE id = ?').run(DELETED);
      expect(Number(removed.changes)).toBe(1);

      const page2 = reader.listPage({
        afterId: page1[page1.length - 1]?.id as PersonaId,
        limit: 4,
      });
      expect(idsOf(page2)).toStrictEqual(IDS.slice(4, 8));

      // The snapshot still holds the old version of the deleted row.
      const page3 = reader.listPage({
        afterId: page2[page2.length - 1]?.id as PersonaId,
        limit: 4,
      });
      expect(idsOf(page3)).toStrictEqual(IDS.slice(8, 12));
      expect(idsOf(page3)).toContain(DELETED);

      collected.push(...idsOf(page1), ...idsOf(page2), ...idsOf(page3));
    });

    expect(collected).toStrictEqual(IDS);
    expect(collected).toContain(DELETED);

    // Control: the delete committed — a fresh snapshot has 11 rows.
    const fresh = withRead(pair.a, () => reader.listPage({ limit: 50 }));
    expect(fresh).toHaveLength(IDS.length - 1);
    expect(idsOf(fresh)).not.toContain(DELETED);
  });
});

describe('events.listPageByPersonaStatus', () => {
  function codeOf(run: () => unknown): string {
    try {
      run();
      return 'no-throw';
    } catch (error) {
      return error instanceof PersistenceError ? error.code : 'not-a-persistence-error';
    }
  }

  it('E1 scans 600 same-status events with no duplicates or omissions', () => {
    const { a } = openPair();
    seedEventPersona(a, EVENT_PERSONA);
    const expected = Array.from({ length: 600 }, (_, index) => eid(index));
    insertReceivedBulk(a, EVENT_PERSONA, expected);
    const events = createRepositories(a).events;

    const seen: EventId[] = [];
    const pageLengths: number[] = [];
    let cursor: EventId | undefined;

    for (let page = 0; page < 8; page += 1) {
      const rows = events.listPageByPersonaStatus(
        cursor === undefined
          ? { personaId: EVENT_PERSONA, status: 'received', limit: 200 }
          : { personaId: EVENT_PERSONA, status: 'received', afterId: cursor, limit: 200 },
      );
      pageLengths.push(rows.length);
      if (rows.length === 0) {
        break;
      }
      const last = rows[rows.length - 1]?.id;
      expect(last).toBeDefined();
      expect(last).not.toBe(cursor);
      for (const row of rows) {
        expect(row.personaId).toBe(EVENT_PERSONA);
        expect(row.status).toBe('received');
      }
      seen.push(...eventIdsOf(rows));
      cursor = last;
    }

    expect(pageLengths).toStrictEqual([200, 200, 200, 0]);
    expect(seen).toStrictEqual(expected);
    expect(new Set(seen).size).toBe(expected.length);
  });

  it('E2 returns only the target persona when another persona shares the status', () => {
    const { a } = openPair();
    seedEventPersona(a, EVENT_PERSONA);
    seedEventPersona(a, EVENT_OTHER);
    const mine = [10, 30, 50].map(eid);
    const theirs = [20, 40, 60].map(eid);
    for (const id of mine) {
      insertEvent(a, { id, personaId: EVENT_PERSONA, status: 'received' });
    }
    for (const id of theirs) {
      insertEvent(a, { id, personaId: EVENT_OTHER, status: 'received' });
    }
    const events = createRepositories(a).events;

    expect(
      eventIdsOf(
        events.listPageByPersonaStatus({
          personaId: EVENT_PERSONA,
          status: 'received',
          limit: 50,
        }),
      ),
    ).toStrictEqual(mine);
    expect(
      eventIdsOf(
        events.listPageByPersonaStatus({
          personaId: EVENT_OTHER,
          status: 'received',
          limit: 50,
        }),
      ),
    ).toStrictEqual(theirs);
  });

  it('E3 returns only the requested status for one persona', () => {
    const { a } = openPair();
    seedEventPersona(a, EVENT_PERSONA);
    const received = [1, 4, 7].map(eid);
    const accepted = [2, 5].map(eid);
    const acted = [3, 6].map(eid);
    for (const id of received) {
      insertEvent(a, { id, personaId: EVENT_PERSONA, status: 'received' });
    }
    for (const id of accepted) {
      insertEvent(a, { id, personaId: EVENT_PERSONA, status: 'accepted' });
    }
    for (const id of acted) {
      insertEvent(a, { id, personaId: EVENT_PERSONA, status: 'acted' });
    }
    const events = createRepositories(a).events;

    expect(
      eventIdsOf(
        events.listPageByPersonaStatus({
          personaId: EVENT_PERSONA,
          status: 'received',
          limit: 50,
        }),
      ),
    ).toStrictEqual(received);
    expect(
      eventIdsOf(
        events.listPageByPersonaStatus({
          personaId: EVENT_PERSONA,
          status: 'accepted',
          limit: 50,
        }),
      ),
    ).toStrictEqual(accepted);
  });

  it('E4 returns an empty page after an exactly full page', () => {
    const { a } = openPair();
    seedEventPersona(a, EVENT_PERSONA);
    const ids = [1, 2, 3, 4].map(eid);
    for (const id of ids) {
      insertEvent(a, { id, personaId: EVENT_PERSONA, status: 'received' });
    }
    const events = createRepositories(a).events;

    const first = events.listPageByPersonaStatus({
      personaId: EVENT_PERSONA,
      status: 'received',
      limit: ids.length,
    });
    expect(first).toHaveLength(ids.length);
    expect(eventIdsOf(first)).toStrictEqual(ids);

    const second = events.listPageByPersonaStatus({
      personaId: EVENT_PERSONA,
      status: 'received',
      afterId: ids[ids.length - 1] as EventId,
      limit: ids.length,
    });
    expect(second).toStrictEqual([]);
  });

  it('E5 rejects an afterId that is not an event id', () => {
    const { a } = openPair();
    seedEventPersona(a, EVENT_PERSONA);
    const id = eid(1);
    insertEvent(a, { id, personaId: EVENT_PERSONA, status: 'received' });
    const events = createRepositories(a).events;

    for (const afterId of ['', 'not-an-id', EVENT_PERSONA, `evt_${'I'.repeat(26)}`]) {
      expect(
        codeOf(() =>
          events.listPageByPersonaStatus({
            personaId: EVENT_PERSONA,
            status: 'received',
            afterId: afterId as EventId,
          }),
        ),
      ).toBe('invalid_argument');
    }

    expect(
      eventIdsOf(
        events.listPageByPersonaStatus({
          personaId: EVENT_PERSONA,
          status: 'received',
          limit: 10,
        }),
      ),
    ).toStrictEqual([id]);
  });

  it('E6 keeps the snapshot when another connection inserts between pages', () => {
    const pair = openPair();
    seedEventPersona(pair.a, EVENT_PERSONA);
    const ids = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120].map(eid);
    const inserted = eid(45);
    for (const id of ids) {
      insertEvent(pair.a, { id, personaId: EVENT_PERSONA, status: 'received' });
    }
    const reader = createRepositories(pair.a).events;
    const writer = createRepositories(pair.b).events;
    const collected: EventId[] = [];

    withRead(pair.a, () => {
      const page1 = reader.listPageByPersonaStatus({
        personaId: EVENT_PERSONA,
        status: 'received',
        limit: 4,
      });
      expect(eventIdsOf(page1)).toStrictEqual(ids.slice(0, 4));

      writer.insert({
        id: inserted,
        personaId: EVENT_PERSONA,
        source: SOURCE,
        adapterId: ADAPTER,
        adapterEventRef: inserted,
        status: 'received',
        receivedAt: NOW,
        updatedAt: NOW,
      });

      const page2 = reader.listPageByPersonaStatus({
        personaId: EVENT_PERSONA,
        status: 'received',
        afterId: page1[page1.length - 1]?.id as EventId,
        limit: 4,
      });
      expect(eventIdsOf(page2)).toStrictEqual(ids.slice(4, 8));

      const page3 = reader.listPageByPersonaStatus({
        personaId: EVENT_PERSONA,
        status: 'received',
        afterId: page2[page2.length - 1]?.id as EventId,
        limit: 4,
      });
      expect(eventIdsOf(page3)).toStrictEqual(ids.slice(8, 12));

      const page4 = reader.listPageByPersonaStatus({
        personaId: EVENT_PERSONA,
        status: 'received',
        afterId: page3[page3.length - 1]?.id as EventId,
        limit: 4,
      });
      expect(page4).toStrictEqual([]);

      collected.push(...eventIdsOf(page1), ...eventIdsOf(page2), ...eventIdsOf(page3));
    });

    expect(collected).toStrictEqual(ids);
    expect(collected).not.toContain(inserted);

    const fresh = withRead(pair.a, () =>
      reader.listPageByPersonaStatus({
        personaId: EVENT_PERSONA,
        status: 'received',
        limit: 50,
      }),
    );
    expect(fresh).toHaveLength(ids.length + 1);
    expect(eventIdsOf(fresh)).toContain(inserted);
  });
});

describe('listPage argument validation', () => {
  // Validation must run before any database access: the store below is a bare
  // object, so a query attempt would throw a TypeError instead of the code below.
  const personas = createPersonaRepository({} as unknown as Store);

  function codeOf(run: () => unknown): string {
    try {
      run();
      return 'no-throw';
    } catch (error) {
      return error instanceof PersistenceError ? error.code : 'not-a-persistence-error';
    }
  }

  it('C1 rejects limit 0', () => {
    expect(codeOf(() => personas.listPage({ limit: 0 }))).toBe('invalid_argument');
  });

  it('C2 rejects limit above the hard ceiling', () => {
    expect(codeOf(() => personas.listPage({ limit: 501 }))).toBe('invalid_argument');
  });

  it('C3 rejects a non-integer limit', () => {
    expect(codeOf(() => personas.listPage({ limit: 1.5 }))).toBe('invalid_argument');
  });

  it('C4 rejects an afterId that is not a persona id', () => {
    expect(codeOf(() => personas.listPage({ afterId: '' as PersonaId }))).toBe('invalid_argument');
    expect(codeOf(() => personas.listPage({ afterId: 'not-an-id' as PersonaId }))).toBe(
      'invalid_argument',
    );
  });
});

describe('pagination SQL contract', () => {
  function normalize(path: string): string {
    return readFileSync(path, 'utf8').replace(/\s+/g, ' ');
  }

  it('D1 uses the primary key as both cursor and sort key', () => {
    const personas = normalize(
      join(import.meta.dirname, '..', 'src', 'repositories', 'personas.ts'),
    );
    const events = normalize(join(import.meta.dirname, '..', 'src', 'repositories', 'events.ts'));

    expect(personas).toContain('FROM personas ORDER BY id ASC LIMIT ?');
    expect(personas).toContain('FROM personas WHERE id > ? ORDER BY id ASC LIMIT ?');

    expect(events).toContain('WHERE persona_id = ? AND status = ? ORDER BY id ASC LIMIT ?');
    expect(events).toContain(
      'WHERE persona_id = ? AND status = ? AND id > ? ORDER BY id ASC LIMIT ?',
    );

    // Timestamps are not unique; they must never be used as a cursor.
    expect(personas).not.toContain('WHERE created_at >');
    expect(events).not.toContain('WHERE received_at >');
  });
});
