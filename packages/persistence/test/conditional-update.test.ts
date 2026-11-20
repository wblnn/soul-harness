/**
 * Atomic conditional writes.
 *
 * Both statements carry their guard in the same SQL statement, so a mismatched
 * expectation writes nothing — proven here by reading the row back from the
 * database rather than trusting the return value.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterId, EventId, PersonaId, SourceId } from '@soul-harness/contracts';

import { databaseOf } from '../src/db/store.js';
import { PersistenceError } from '../src/errors.js';
import { createRepositories } from '../src/index.js';
import { closeAll, NOW, openMigratedStore } from './helpers/fixture.js';

afterEach(closeAll);

const BODY = '01JQ8Z3K5M7P9R2T4V6X8Z';
const PERSONA = `psn_${BODY}0010` as PersonaId;
const PERSONA_B = `psn_${BODY}0020` as PersonaId;
const EVENT_1 = `evt_${BODY}0010` as EventId;
const EVENT_2 = `evt_${BODY}0020` as EventId;
const EVENT_3 = `evt_${BODY}0030` as EventId;
const ADAPTER = 'qq' as AdapterId;
const SOURCE = 'qq' as SourceId;

function seedPersona(store: ReturnType<typeof openMigratedStore>) {
  const repos = createRepositories(store);
  const persona = repos.personas.insert({
    id: PERSONA,
    displayName: 'Conditional',
    state: 'STARTING',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { repos, persona };
}

function insertEvent(
  repos: ReturnType<typeof createRepositories>,
  id: EventId,
  ref: string,
  status: 'received' | 'accepted' | 'acted',
  attentionOutcome: 'not_evaluated' | 'queued' | 'fully_aware' | null,
  personaId: PersonaId = PERSONA,
) {
  return repos.events.insert({
    id,
    personaId,
    source: SOURCE,
    adapterId: ADAPTER,
    adapterEventRef: ref,
    status,
    attentionOutcome,
    receivedAt: NOW,
    updatedAt: NOW,
  });
}

function codeOf(run: () => unknown): string {
  try {
    run();
    return 'no-throw';
  } catch (error) {
    return error instanceof PersistenceError ? error.code : 'not-a-persistence-error';
  }
}

describe('personas.compareAndSetState', () => {
  it('B1 applies the change and bumps version by exactly one', () => {
    const store = openMigratedStore();
    const { repos, persona } = seedPersona(store);
    expect(persona.version).toBe(0);

    const result = repos.personas.compareAndSetState({
      id: PERSONA,
      expectedState: 'STARTING',
      expectedVersion: 0,
      nextState: 'STOPPED',
      updatedAt: NOW + 1,
    });

    expect(result).toMatchObject({ id: PERSONA, state: 'STOPPED', version: 1, updatedAt: NOW + 1 });
    // Read back from the database, not from the returned row.
    expect(repos.personas.getById(PERSONA)).toMatchObject({
      state: 'STOPPED',
      version: 1,
      updatedAt: NOW + 1,
    });
  });

  it('B2 writes nothing when the expected state does not match', () => {
    const store = openMigratedStore();
    const { repos } = seedPersona(store);

    const result = repos.personas.compareAndSetState({
      id: PERSONA,
      expectedState: 'RUNNING',
      expectedVersion: 0,
      nextState: 'STOPPED',
      updatedAt: NOW + 2,
    });

    expect(result).toBeNull();
    expect(repos.personas.getById(PERSONA)).toMatchObject({
      state: 'STARTING',
      version: 0,
      updatedAt: NOW,
    });
  });

  it('B3 writes nothing when the expected version does not match', () => {
    const store = openMigratedStore();
    const { repos } = seedPersona(store);

    const result = repos.personas.compareAndSetState({
      id: PERSONA,
      expectedState: 'STARTING',
      expectedVersion: 99,
      nextState: 'STOPPED',
      updatedAt: NOW + 3,
    });

    expect(result).toBeNull();
    expect(repos.personas.getById(PERSONA)).toMatchObject({
      state: 'STARTING',
      version: 0,
      updatedAt: NOW,
    });
  });
});

describe('events.expireIfActive', () => {
  it('B4 expires a received event and leaves attention_outcome alone', () => {
    const store = openMigratedStore();
    const { repos } = seedPersona(store);
    const event = insertEvent(repos, EVENT_1, 'ref-received', 'received', 'queued');

    const result = repos.events.expireIfActive({
      id: EVENT_1,
      personaId: PERSONA,
      updatedAt: NOW + 10,
    });

    expect(result).toMatchObject({
      status: 'expired',
      statusReason: 'buffer_lost',
      attentionOutcome: 'queued',
      updatedAt: NOW + 10,
    });
    const stored = repos.events.getById(EVENT_1);
    expect(stored?.status).toBe('expired');
    expect(stored?.statusReason).toBe('buffer_lost');
    expect(stored?.attentionOutcome).toBe('queued');
    expect(stored?.updatedAt).toBe(NOW + 10);
    expect(stored?.id).toBe(event.id);
  });

  it('B5 expires an accepted event', () => {
    const store = openMigratedStore();
    const { repos } = seedPersona(store);
    insertEvent(repos, EVENT_2, 'ref-accepted', 'accepted', null);

    const result = repos.events.expireIfActive({
      id: EVENT_2,
      personaId: PERSONA,
      updatedAt: NOW + 20,
    });

    expect(result?.status).toBe('expired');
    const stored = repos.events.getById(EVENT_2);
    expect(stored).toMatchObject({
      status: 'expired',
      statusReason: 'buffer_lost',
      attentionOutcome: null,
      updatedAt: NOW + 20,
    });
  });

  it('B6 never rewrites a terminal row, and preserves every other field', () => {
    const store = openMigratedStore();
    const { repos } = seedPersona(store);

    const acted = insertEvent(repos, EVENT_1, 'ref-acted', 'acted', 'fully_aware');

    insertEvent(repos, EVENT_2, 'ref-rejected', 'received', null);
    const rejected = repos.events.updateStatus({
      id: EVENT_2,
      status: 'rejected',
      statusReason: 'auth_failed',
      attentionOutcome: null,
      updatedAt: NOW + 5,
    });

    insertEvent(repos, EVENT_3, 'ref-expired', 'received', null);
    const expired = repos.events.updateStatus({
      id: EVENT_3,
      status: 'expired',
      statusReason: 'buffer_lost',
      attentionOutcome: null,
      updatedAt: NOW + 6,
    });

    for (const row of [acted, rejected, expired]) {
      expect(row).not.toBeNull();
      const before = row as NonNullable<typeof row>;

      expect(
        repos.events.expireIfActive({
          id: before.id,
          personaId: PERSONA,
          updatedAt: NOW + 999,
        }),
      ).toBeNull();

      const after = repos.events.getById(before.id);
      expect(after?.status).toBe(before.status);
      expect(after?.statusReason).toBe(before.statusReason);
      expect(after?.attentionOutcome).toBe(before.attentionOutcome);
      expect(after?.updatedAt).toBe(before.updatedAt);
      expect(after?.salience).toBe(before.salience);
      expect(after?.archiveState).toBe(before.archiveState);
    }
  });

  it("B7 does not modify another persona's event", () => {
    const store = openMigratedStore();
    const { repos } = seedPersona(store);
    repos.personas.insert({
      id: PERSONA_B,
      displayName: 'Other',
      state: 'STARTING',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const ownedByB = insertEvent(repos, EVENT_1, 'ref-b', 'received', 'queued', PERSONA_B);

    // Persona A's scope must not reach Persona B's row, even though the id
    // exists and the row is otherwise eligible (received, archive_state none).
    expect(
      repos.events.expireIfActive({ id: EVENT_1, personaId: PERSONA, updatedAt: NOW + 40 }),
    ).toBeNull();

    expect(repos.events.getById(EVENT_1)).toMatchObject({
      id: ownedByB.id,
      personaId: PERSONA_B,
      status: 'received',
      statusReason: null,
      attentionOutcome: 'queued',
      updatedAt: NOW,
      archiveState: 'none',
      salience: ownedByB.salience,
    });

    // Control: the same row expires once the scope matches, so the miss above
    // was the persona guard and not an ineligible status.
    expect(
      repos.events.expireIfActive({ id: EVENT_1, personaId: PERSONA_B, updatedAt: NOW + 41 }),
    ).toMatchObject({
      personaId: PERSONA_B,
      status: 'expired',
      statusReason: 'buffer_lost',
      attentionOutcome: 'queued',
      updatedAt: NOW + 41,
    });
  });

  it.each([
    ['pending', 'received'],
    ['archived', 'accepted'],
    ['failed', 'received'],
    ['excluded', 'accepted'],
  ] as const)(
    'B8 does not expire archive_state %s while status is still %s',
    (archiveState, status) => {
      const store = openMigratedStore();
      const { repos } = seedPersona(store);
      const before = insertEvent(repos, EVENT_1, `ref-${archiveState}`, status, 'queued');
      const written = databaseOf(store)
        .prepare('UPDATE events SET archive_state = ? WHERE id = ?')
        .run(archiveState, EVENT_1);
      expect(Number(written.changes)).toBe(1);

      expect(
        repos.events.expireIfActive({ id: EVENT_1, personaId: PERSONA, updatedAt: NOW + 80 }),
      ).toBeNull();

      expect(repos.events.getById(EVENT_1)).toMatchObject({
        status: before.status,
        statusReason: before.statusReason,
        attentionOutcome: 'queued',
        updatedAt: before.updatedAt,
        archiveState,
        salience: before.salience,
      });
    },
  );

  it('B9 rejects a personaId that is not a persona id before writing', () => {
    const store = openMigratedStore();
    const { repos } = seedPersona(store);
    insertEvent(repos, EVENT_1, 'ref-bad-scope', 'received', 'queued');

    for (const personaId of ['', 'not-a-persona', EVENT_1]) {
      expect(
        codeOf(() =>
          repos.events.expireIfActive({
            id: EVENT_1,
            personaId: personaId as PersonaId,
            updatedAt: NOW + 3,
          }),
        ),
      ).toBe('invalid_identifier');
    }

    expect(repos.events.getById(EVENT_1)).toMatchObject({
      status: 'received',
      statusReason: null,
      attentionOutcome: 'queued',
      updatedAt: NOW,
      archiveState: 'none',
    });
  });
});

describe('conditional update SQL contract', () => {
  function normalize(path: string): string {
    return readFileSync(path, 'utf8').replace(/\s+/g, ' ');
  }

  it('D2 keeps the persona, status and archive_state guards inside the UPDATE', () => {
    const personas = normalize(
      join(import.meta.dirname, '..', 'src', 'repositories', 'personas.ts'),
    );
    const events = normalize(join(import.meta.dirname, '..', 'src', 'repositories', 'events.ts'));

    expect(personas).toContain('version = version + 1');
    expect(personas).toContain('WHERE id = ? AND state = ? AND version = ?');

    expect(events).toContain("SET status = 'expired', status_reason = 'buffer_lost'");
    expect(events).toContain(
      "WHERE persona_id = ? AND id = ? AND status IN ('received', 'accepted') AND archive_state = 'none'",
    );
    expect(events).not.toContain("WHERE id = ? AND status IN ('received', 'accepted')");
  });
});
