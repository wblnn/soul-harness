/**
 * Storage primitives SH-008C needs and the existing repositories do not provide
 * atomically: open-or-reuse a session without reviving a closed one, commit a
 * P1 envelope from received to its outcome in one transaction, and expire an
 * active P1 row with a caller-supplied reason.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AdapterId, EventId, PersonaId, SessionId, SourceId } from '@soul-harness/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { databaseOf } from '../src/db/store.js';
import { isPersistenceError } from '../src/errors.js';
import { createRepositories } from '../src/index.js';
import type { Repositories } from '../src/index.js';
import { closeAll, NOW, openMigratedStore } from './helpers/fixture.js';

afterEach(closeAll);

const BODY = '01JQ8Z3K5M7P9R2T4V6X8Z';
const PERSONA = `psn_${BODY}0C10` as PersonaId;
const PERSONA_B = `psn_${BODY}0C20` as PersonaId;
const SESSION = `ses_${BODY}0C10` as SessionId;
const SESSION_B = `ses_${BODY}0C20` as SessionId;
const EVENT = `evt_${BODY}0C10` as EventId;
const EVENT_B = `evt_${BODY}0C20` as EventId;
const ADAPTER = 'minecraft' as AdapterId;
const ADAPTER_B = 'qq' as AdapterId;
const SOURCE = 'minecraft.chat' as SourceId;

function repos(): Repositories {
  return createRepositories(openMigratedStore());
}

function seedPersona(storeRepos: Repositories, id: PersonaId = PERSONA): void {
  storeRepos.personas.insert({
    id,
    displayName: 'Ingress',
    state: 'RUNNING',
    createdAt: NOW,
    updatedAt: NOW,
  });
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

describe('sessions.openActive', () => {
  it('reuses the open mapping and does not insert the candidate id', () => {
    const storeRepos = repos();
    seedPersona(storeRepos);
    storeRepos.sessions.insert({
      id: SESSION,
      personaId: PERSONA,
      adapterId: ADAPTER,
      externalId: 'dsh:abc123',
      openedAt: NOW,
    });

    const opened = storeRepos.sessions.openActive({
      id: SESSION_B,
      personaId: PERSONA,
      adapterId: ADAPTER,
      externalId: 'dsh:abc123',
      openedAt: NOW + 5,
    });

    expect(opened.created).toBe(false);
    expect(opened.session.id).toBe(SESSION);
    expect(storeRepos.sessions.getById(SESSION_B)).toBeNull();
    expect(storeRepos.sessions.listByPersona(PERSONA)).toHaveLength(1);
  });

  it('allocates a new id after the old window is closed and leaves the old row closed', () => {
    const storeRepos = repos();
    seedPersona(storeRepos);
    storeRepos.sessions.insert({
      id: SESSION,
      personaId: PERSONA,
      adapterId: ADAPTER,
      externalId: 'dsh:abc123',
      openedAt: NOW,
    });
    expect(storeRepos.sessions.close({ id: SESSION, closedAt: NOW + 1 })).toBe(true);

    const opened = storeRepos.sessions.openActive({
      id: SESSION_B,
      personaId: PERSONA,
      adapterId: ADAPTER,
      externalId: 'dsh:abc123',
      openedAt: NOW + 2,
    });

    expect(opened).toMatchObject({ created: true, session: { id: SESSION_B, closedAt: null } });
    expect(storeRepos.sessions.getById(SESSION)).toMatchObject({
      closedAt: NOW + 1,
      externalId: 'dsh:abc123',
    });
    expect(
      storeRepos.sessions.findActiveByExternal({
        personaId: PERSONA,
        adapterId: ADAPTER,
        externalId: 'dsh:abc123',
      })?.id,
    ).toBe(SESSION_B);
  });

  it('does not treat another persona or another adapter as the same window', () => {
    const storeRepos = repos();
    seedPersona(storeRepos);
    seedPersona(storeRepos, PERSONA_B);
    storeRepos.sessions.insert({
      id: SESSION,
      personaId: PERSONA,
      adapterId: ADAPTER,
      externalId: 'dsh:abc123',
      openedAt: NOW,
    });

    const otherPersona = storeRepos.sessions.openActive({
      id: SESSION_B,
      personaId: PERSONA_B,
      adapterId: ADAPTER,
      externalId: 'dsh:abc123',
      openedAt: NOW + 1,
    });
    const otherAdapter = storeRepos.sessions.openActive({
      id: `ses_${BODY}0C30` as SessionId,
      personaId: PERSONA,
      adapterId: ADAPTER_B,
      externalId: 'dsh:abc123',
      openedAt: NOW + 2,
    });

    expect(otherPersona.created).toBe(true);
    expect(otherAdapter.created).toBe(true);
    expect(otherPersona.session.id).not.toBe(SESSION);
    expect(otherAdapter.session.id).not.toBe(SESSION);
  });

  it('rethrows a primary-key conflict instead of reviving or inserting a second open row', () => {
    const storeRepos = repos();
    seedPersona(storeRepos);
    storeRepos.sessions.insert({
      id: SESSION,
      personaId: PERSONA,
      adapterId: ADAPTER,
      externalId: 'dsh:taken',
      openedAt: NOW,
    });

    expect(
      codeOf(() =>
        storeRepos.sessions.openActive({
          id: SESSION,
          personaId: PERSONA,
          adapterId: ADAPTER,
          externalId: 'dsh:fresh',
          openedAt: NOW + 1,
        }),
      ),
    ).toBe('unique_conflict');

    expect(storeRepos.sessions.getById(SESSION)).toMatchObject({
      externalId: 'dsh:taken',
      closedAt: null,
    });
    expect(
      storeRepos.sessions.findActiveByExternal({
        personaId: PERSONA,
        adapterId: ADAPTER,
        externalId: 'dsh:fresh',
      }),
    ).toBeNull();
    expect(storeRepos.sessions.listByPersona(PERSONA)).toHaveLength(1);
  });

  it('rejects an illegal external id before opening a transaction', () => {
    const store = openMigratedStore();
    const storeRepos = createRepositories(store);
    seedPersona(storeRepos);
    const before = databaseOf(store).prepare('SELECT count(*) AS n FROM sessions').get() as {
      n: number;
    };

    for (const externalId of ['', '  dsh', 'dsh  ', 'dsh id', 'a'.repeat(257), 'dsh\nref']) {
      expect(
        codeOf(() =>
          storeRepos.sessions.openActive({
            id: SESSION,
            personaId: PERSONA,
            adapterId: ADAPTER,
            externalId,
            openedAt: NOW,
          }),
        ),
      ).toBe('invalid_argument');
    }

    const after = databaseOf(store).prepare('SELECT count(*) AS n FROM sessions').get() as {
      n: number;
    };
    expect(after.n).toBe(before.n);
  });
});

describe('events.commitP1Envelope', () => {
  it('commits accepted with archive columns left at the P1 defaults', () => {
    const storeRepos = repos();
    seedPersona(storeRepos);
    storeRepos.sessions.insert({
      id: SESSION,
      personaId: PERSONA,
      adapterId: ADAPTER,
      externalId: 'dsh:abc123',
      openedAt: NOW,
    });

    const row = storeRepos.events.commitP1Envelope({
      id: EVENT,
      personaId: PERSONA,
      sessionId: SESSION,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-7f3a9c21',
      receivedAt: NOW + 50,
      occurredAt: NOW,
      updatedAt: NOW + 50,
      outcome: { status: 'accepted' },
      // Sneaked fields must not be written. The parameter list does not name them.
      ...({ summary: 'CANARY', archiveRef: 'secret', archiveState: 'pending' } as object),
    });

    expect(row).toMatchObject({
      id: EVENT,
      status: 'accepted',
      statusReason: null,
      sessionId: SESSION,
      receivedAt: NOW + 50,
      occurredAt: NOW,
      summary: null,
      archiveRef: null,
      archiveDisposition: null,
      archiveState: 'none',
      attentionOutcome: null,
    });
    expect(storeRepos.events.getById(EVENT)).toMatchObject({ status: 'accepted', summary: null });
  });

  it('commits queue_overflow as expired in the same transaction and keeps occurredAt', () => {
    const storeRepos = repos();
    seedPersona(storeRepos);

    const row = storeRepos.events.commitP1Envelope({
      id: EVENT,
      personaId: PERSONA,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-overflow',
      receivedAt: 8_000,
      occurredAt: 10,
      updatedAt: 8_000,
      outcome: { status: 'expired', reason: 'queue_overflow' },
    });

    expect(row).toMatchObject({
      status: 'expired',
      statusReason: 'queue_overflow',
      receivedAt: 8_000,
      occurredAt: 10,
      archiveState: 'none',
      archiveDisposition: null,
      archiveRef: null,
      summary: null,
    });
    expect(
      storeRepos.events.listByPersonaStatus({ personaId: PERSONA, status: 'received' }),
    ).toEqual([]);
  });

  it('rolls back when the dedupe key is already taken and does not leave a second row', () => {
    const storeRepos = repos();
    seedPersona(storeRepos);
    storeRepos.events.commitP1Envelope({
      id: EVENT,
      personaId: PERSONA,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-same',
      receivedAt: NOW,
      updatedAt: NOW,
      outcome: { status: 'accepted' },
    });

    expect(
      codeOf(() =>
        storeRepos.events.commitP1Envelope({
          id: EVENT_B,
          personaId: PERSONA,
          source: SOURCE,
          adapterId: ADAPTER,
          adapterEventRef: 'mc-same',
          receivedAt: NOW + 1,
          updatedAt: NOW + 1,
          outcome: { status: 'accepted' },
        }),
      ),
    ).toBe('unique_conflict');

    expect(storeRepos.events.getById(EVENT_B)).toBeNull();
    expect(storeRepos.events.getById(EVENT)).toMatchObject({
      status: 'accepted',
      statusReason: null,
      receivedAt: NOW,
    });
  });

  it('rejects a malformed adapter reference before writing', () => {
    const store = openMigratedStore();
    const storeRepos = createRepositories(store);
    seedPersona(storeRepos);

    expect(
      codeOf(() =>
        storeRepos.events.commitP1Envelope({
          id: EVENT,
          personaId: PERSONA,
          source: SOURCE,
          adapterId: ADAPTER,
          adapterEventRef: 'has space',
          receivedAt: NOW,
          updatedAt: NOW,
          outcome: { status: 'accepted' },
        }),
      ),
    ).toBe('invalid_identifier');
    expect(storeRepos.events.getById(EVENT)).toBeNull();
  });

  it('inserts received and updates it before the write transaction returns', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'src', 'repositories', 'events.ts'),
      'utf8',
    );
    const commit = source.slice(
      source.indexOf('commitP1Envelope('),
      source.indexOf('expireActive('),
    );
    const collapsed = commit.replace(/\s+/g, ' ');

    expect(collapsed).toContain("VALUES (?, ?, ?, ?, ?, ?, 'received'");
    expect(collapsed).toContain('SET status = ?, status_reason = ?, updated_at = ?');
    expect(collapsed).toContain("WHERE id = ? AND status = 'received' AND archive_state = 'none'");
    const inserted = collapsed.slice(0, collapsed.indexOf('UPDATE events'));
    expect(inserted).not.toContain('archive_');
    expect(collapsed).not.toContain('archive_ref');
    expect(collapsed).not.toContain('archive_disposition');
  });
});

describe('events.expireActive', () => {
  it('expires an accepted P1 event with ttl_expired and leaves other fields', () => {
    const storeRepos = repos();
    seedPersona(storeRepos);
    storeRepos.events.insert({
      id: EVENT,
      personaId: PERSONA,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-ttl',
      status: 'accepted',
      attentionOutcome: 'queued',
      receivedAt: NOW,
      updatedAt: NOW,
    });

    const row = storeRepos.events.expireActive({
      id: EVENT,
      personaId: PERSONA,
      updatedAt: NOW + 9,
      reason: 'ttl_expired',
    });

    expect(row).toMatchObject({
      status: 'expired',
      statusReason: 'ttl_expired',
      attentionOutcome: 'queued',
      updatedAt: NOW + 9,
      archiveState: 'none',
    });
  });

  it('does not rewrite a terminal row or another persona', () => {
    const storeRepos = repos();
    seedPersona(storeRepos);
    seedPersona(storeRepos, PERSONA_B);
    storeRepos.events.insert({
      id: EVENT,
      personaId: PERSONA,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-rejected',
      status: 'received',
      receivedAt: NOW,
      updatedAt: NOW,
    });
    storeRepos.events.updateStatus({
      id: EVENT,
      status: 'rejected',
      statusReason: 'auth_failed',
      attentionOutcome: null,
      updatedAt: NOW + 1,
    });
    storeRepos.events.insert({
      id: EVENT_B,
      personaId: PERSONA_B,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-other',
      status: 'accepted',
      receivedAt: NOW,
      updatedAt: NOW,
    });

    expect(
      storeRepos.events.expireActive({
        id: EVENT,
        personaId: PERSONA,
        updatedAt: NOW + 20,
        reason: 'ttl_expired',
      }),
    ).toBeNull();
    expect(
      storeRepos.events.expireActive({
        id: EVENT_B,
        personaId: PERSONA,
        updatedAt: NOW + 21,
        reason: 'queue_overflow',
      }),
    ).toBeNull();

    expect(storeRepos.events.getById(EVENT)).toMatchObject({
      status: 'rejected',
      statusReason: 'auth_failed',
      updatedAt: NOW + 1,
    });
    expect(storeRepos.events.getById(EVENT_B)).toMatchObject({
      status: 'accepted',
      statusReason: null,
      personaId: PERSONA_B,
    });
  });

  it('does not expire a non-none archive state', () => {
    const store = openMigratedStore();
    const storeRepos = createRepositories(store);
    seedPersona(storeRepos);
    storeRepos.events.insert({
      id: EVENT,
      personaId: PERSONA,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-pending',
      status: 'received',
      receivedAt: NOW,
      updatedAt: NOW,
    });
    databaseOf(store)
      .prepare('UPDATE events SET archive_state = ? WHERE id = ?')
      .run('pending', EVENT);

    expect(
      storeRepos.events.expireActive({
        id: EVENT,
        personaId: PERSONA,
        updatedAt: NOW + 3,
        reason: 'ttl_expired',
      }),
    ).toBeNull();
    expect(storeRepos.events.getById(EVENT)).toMatchObject({
      status: 'received',
      statusReason: null,
      archiveState: 'pending',
    });
  });

  it('rejects an illegal reason or persona id before writing', () => {
    const storeRepos = repos();
    seedPersona(storeRepos);
    storeRepos.events.insert({
      id: EVENT,
      personaId: PERSONA,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-bad',
      status: 'accepted',
      receivedAt: NOW,
      updatedAt: NOW,
    });

    expect(
      codeOf(() =>
        storeRepos.events.expireActive({
          id: EVENT,
          personaId: PERSONA,
          updatedAt: NOW + 1,
          reason: 'auth_failed' as 'ttl_expired',
        }),
      ),
    ).toBe('invalid_argument');
    expect(
      codeOf(() =>
        storeRepos.events.expireActive({
          id: EVENT,
          personaId: 'nope' as PersonaId,
          updatedAt: NOW + 1,
          reason: 'ttl_expired',
        }),
      ),
    ).toBe('invalid_identifier');
    expect(storeRepos.events.getById(EVENT)).toMatchObject({ status: 'accepted', updatedAt: NOW });
  });
});

describe('events.rejectIfActive', () => {
  it('rejects an accepted P1 event with processing_failed', () => {
    const storeRepos = repos();
    seedPersona(storeRepos);
    storeRepos.events.insert({
      id: EVENT,
      personaId: PERSONA,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-reject',
      status: 'accepted',
      attentionOutcome: 'queued',
      receivedAt: NOW,
      updatedAt: NOW,
    });

    const row = storeRepos.events.rejectIfActive({
      id: EVENT,
      personaId: PERSONA,
      updatedAt: NOW + 4,
      reason: 'processing_failed',
    });

    expect(row).toMatchObject({
      status: 'rejected',
      statusReason: 'processing_failed',
      attentionOutcome: 'queued',
      updatedAt: NOW + 4,
      archiveState: 'none',
    });
  });

  it('does not rewrite a terminal row or another persona', () => {
    const storeRepos = repos();
    seedPersona(storeRepos);
    seedPersona(storeRepos, PERSONA_B);
    storeRepos.events.insert({
      id: EVENT,
      personaId: PERSONA,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-expired',
      status: 'received',
      receivedAt: NOW,
      updatedAt: NOW,
    });
    storeRepos.events.updateStatus({
      id: EVENT,
      status: 'expired',
      statusReason: 'ttl_expired',
      attentionOutcome: null,
      updatedAt: NOW + 1,
    });
    storeRepos.events.insert({
      id: EVENT_B,
      personaId: PERSONA_B,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-b',
      status: 'accepted',
      receivedAt: NOW,
      updatedAt: NOW,
    });

    expect(
      storeRepos.events.rejectIfActive({
        id: EVENT,
        personaId: PERSONA,
        updatedAt: NOW + 8,
        reason: 'processing_failed',
      }),
    ).toBeNull();
    expect(
      storeRepos.events.rejectIfActive({
        id: EVENT_B,
        personaId: PERSONA,
        updatedAt: NOW + 9,
        reason: 'processing_failed',
      }),
    ).toBeNull();
    expect(storeRepos.events.getById(EVENT)).toMatchObject({
      status: 'expired',
      statusReason: 'ttl_expired',
    });
    expect(storeRepos.events.getById(EVENT_B)).toMatchObject({
      status: 'accepted',
      personaId: PERSONA_B,
    });
  });

  it('does not reject a non-none archive state', () => {
    const store = openMigratedStore();
    const storeRepos = createRepositories(store);
    seedPersona(storeRepos);
    storeRepos.events.insert({
      id: EVENT,
      personaId: PERSONA,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-arch',
      status: 'accepted',
      receivedAt: NOW,
      updatedAt: NOW,
    });
    databaseOf(store)
      .prepare('UPDATE events SET archive_state = ? WHERE id = ?')
      .run('pending', EVENT);

    expect(
      storeRepos.events.rejectIfActive({
        id: EVENT,
        personaId: PERSONA,
        updatedAt: NOW + 2,
        reason: 'processing_failed',
      }),
    ).toBeNull();
    expect(storeRepos.events.getById(EVENT)).toMatchObject({
      status: 'accepted',
      archiveState: 'pending',
    });
  });

  it('rejects an expiry reason before writing', () => {
    const storeRepos = repos();
    seedPersona(storeRepos);
    storeRepos.events.insert({
      id: EVENT,
      personaId: PERSONA,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-reason',
      status: 'accepted',
      receivedAt: NOW,
      updatedAt: NOW,
    });

    expect(
      codeOf(() =>
        storeRepos.events.rejectIfActive({
          id: EVENT,
          personaId: PERSONA,
          updatedAt: NOW + 1,
          reason: 'buffer_lost' as 'processing_failed',
        }),
      ),
    ).toBe('invalid_argument');
    expect(storeRepos.events.getById(EVENT)?.status).toBe('accepted');
  });
});
