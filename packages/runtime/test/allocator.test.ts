/**
 * Allocator unit tests: frozen bit layout, injected clock and entropy,
 * collision retry, and a real SQLite primary key as the backstop.
 *
 * The large-sample CI gate lives in `allocator-sample.test.ts` (OPEN-7).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  ID_ALPHABET,
  ID_TOTAL_LENGTH,
  isActionId,
  isAuxiliaryId,
  isConflictRecordId,
  isCoreId,
  isEventId,
  isPersonaId,
  isRunId,
  isSessionId,
  isTaskId,
  isThreadId,
} from '@soul-harness/contracts';
import { describe, expect, it } from 'vitest';

import {
  ALLOCATABLE_PREFIXES,
  ID_ALLOCATION_MAX_ATTEMPTS,
  ID_ENTROPY_BYTES,
  RuntimeError,
  allocateActionId,
  allocateConflictRecordId,
  allocateEventId,
  allocateId,
  allocatePersonaId,
  allocateRunId,
  allocateSessionId,
  allocateTaskId,
  allocateThreadId,
  isRuntimeError,
} from '../src/index.js';
import type { AllocatablePrefix } from '../src/index.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function fill(value: number): Uint8Array {
  return new Uint8Array(ID_ENTROPY_BYTES).fill(value);
}

function script(chunks: readonly Uint8Array[]): (size: number) => Uint8Array {
  let index = 0;
  return (size: number) => {
    if (size !== ID_ENTROPY_BYTES) {
      throw new Error(`unexpected entropy size ${String(size)}`);
    }
    const next = chunks[index];
    index += 1;
    if (next === undefined) {
      throw new Error('scripted entropy exhausted');
    }
    return next;
  };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isRuntimeError(error)) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected the call to throw');
}

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('allocator — frozen layout', () => {
  it('encodes a zero timestamp and zero entropy as 26 zero characters', () => {
    expect(allocatePersonaId({ now: () => 0, randomBytes: () => fill(0) })).toBe(
      `psn_${'0'.repeat(26)}`,
    );
  });

  it('encodes an all-ones entropy section as 16 Z characters', () => {
    expect(allocatePersonaId({ now: () => 0, randomBytes: () => fill(0xff) })).toBe(
      `psn_${'0'.repeat(10)}${'Z'.repeat(16)}`,
    );
  });

  it('encodes small timestamps in the low digits, not by shifting into the high bits', () => {
    expect(allocatePersonaId({ now: () => 1, randomBytes: () => fill(0) })).toBe(
      `psn_${'0'.repeat(9)}1${'0'.repeat(16)}`,
    );
    expect(allocatePersonaId({ now: () => 31, randomBytes: () => fill(0) })).toBe(
      `psn_${'0'.repeat(9)}Z${'0'.repeat(16)}`,
    );
    expect(allocatePersonaId({ now: () => 32, randomBytes: () => fill(0) })).toBe(
      `psn_${'0'.repeat(8)}10${'0'.repeat(16)}`,
    );
  });

  it('zero-pads the 48-bit timestamp into the high end of the 50-bit field', () => {
    // 2^45 sets only the least significant bit of the first character.
    expect(allocatePersonaId({ now: () => 2 ** 45, randomBytes: () => fill(0) })).toBe(
      `psn_1${'0'.repeat(25)}`,
    );
    // 2^48-1 fills the low 48 bits. The top two bits stay 0, so the first
    // character is 7 (0b00111), and the other nine time characters are Z.
    expect(allocatePersonaId({ now: () => 2 ** 48 - 1, randomBytes: () => fill(0) })).toBe(
      `psn_7${'Z'.repeat(9)}${'0'.repeat(16)}`,
    );
  });

  it('lays entropy out big-endian, five bits at a time', () => {
    const entropy = new Uint8Array(ID_ENTROPY_BYTES);
    entropy[0] = 0xf8; // 1111_1000 → first group 11111 = Z, then zeros
    expect(allocatePersonaId({ now: () => 0, randomBytes: () => entropy })).toBe(
      `psn_${'0'.repeat(10)}Z${'0'.repeat(15)}`,
    );
    expect(allocatePersonaId({ now: () => 2 ** 48 - 1, randomBytes: () => entropy })).toBe(
      `psn_7${'Z'.repeat(10)}${'0'.repeat(15)}`,
    );
  });

  it('keeps every generated wire string inside the contracts alphabet and length', () => {
    const id = allocatePersonaId({ now: () => 1_700_000_000_000, randomBytes: () => fill(0x3c) });
    expect(id).toHaveLength(ID_TOTAL_LENGTH);
    expect(isPersonaId(id)).toBe(true);
    expect(id.charAt(4)).toMatch(/[0-7]/u);
    for (const char of id.slice(4)) {
      expect(ID_ALPHABET.includes(char)).toBe(true);
      expect('ILOU'.includes(char)).toBe(false);
    }
  });
});

describe('allocator — prefixes stay disjoint', () => {
  const atZero = { now: () => 0, randomBytes: () => fill(0) } as const;

  it('gives every prefix the same body and only its own parser', () => {
    const persona = allocatePersonaId(atZero);
    const session = allocateSessionId(atZero);
    const thread = allocateThreadId(atZero);
    const run = allocateRunId(atZero);
    const event = allocateEventId(atZero);
    const action = allocateActionId(atZero);
    const task = allocateTaskId(atZero);
    const conflict = allocateConflictRecordId(atZero);

    const ids = [persona, session, thread, run, event, action, task, conflict];
    const bodies = new Set(ids.map((id) => id.slice(4)));
    expect(bodies.size).toBe(1);

    expect(isPersonaId(persona)).toBe(true);
    expect(isSessionId(session)).toBe(true);
    expect(isThreadId(thread)).toBe(true);
    expect(isRunId(run)).toBe(true);
    expect(isEventId(event)).toBe(true);
    expect(isActionId(action)).toBe(true);
    expect(isTaskId(task)).toBe(true);
    expect(isConflictRecordId(conflict)).toBe(true);

    expect(isCoreId(persona)).toBe(true);
    expect(isCoreId(task)).toBe(false);
    expect(isCoreId(conflict)).toBe(false);
    expect(isAuxiliaryId(task)).toBe(true);
    expect(isAuxiliaryId(conflict)).toBe(true);
    expect(isAuxiliaryId(persona)).toBe(false);
    expect(isTaskId(conflict)).toBe(false);
    expect(isConflictRecordId(task)).toBe(false);
    expect(isPersonaId(session)).toBe(false);
    expect(isSessionId(persona)).toBe(false);
  });

  it('exposes one allocator per frozen prefix and no other prefix', () => {
    expect([...ALLOCATABLE_PREFIXES]).toEqual([
      'psn',
      'ses',
      'thr',
      'run',
      'evt',
      'act',
      'tsk',
      'cnf',
    ]);
    expect(codeOf(() => allocateId('boot' as AllocatablePrefix))).toBe('invalid_argument');
    expect(codeOf(() => allocateId('PSN' as AllocatablePrefix))).toBe('invalid_argument');
  });
});

describe('allocator — clock and entropy', () => {
  it('tracks an injected clock, including backwards, and does not bump the same millisecond', () => {
    const earlier = allocateEventId({ now: () => 10, randomBytes: () => fill(0) });
    const later = allocateEventId({ now: () => 10_000, randomBytes: () => fill(0) });
    const sameA = allocateEventId({ now: () => 10_000, randomBytes: () => fill(1) });
    const sameB = allocateEventId({ now: () => 10_000, randomBytes: () => fill(2) });
    const nextMs = allocateEventId({ now: () => 10_001, randomBytes: () => fill(0) });

    expect(earlier.slice(4, 14) < later.slice(4, 14)).toBe(true);
    expect(sameA.slice(4, 14)).toBe(later.slice(4, 14));
    expect(sameB.slice(4, 14)).toBe(later.slice(4, 14));
    expect(sameA.slice(14)).not.toBe(sameB.slice(14));
    expect(later.slice(4, 14) < nextMs.slice(4, 14)).toBe(true);
  });

  it('reads the clock again on each retry so a moved clock changes the prefix', () => {
    const stamps = [1_000, 5_000];
    let index = 0;
    const id = allocatePersonaId({
      now: () => {
        const stamp = stamps[index] ?? 5_000;
        return stamp;
      },
      randomBytes: script([fill(1), fill(2)]),
      isOccupied: () => {
        index += 1;
        return index === 1;
      },
    });
    const atRetryClock = allocatePersonaId({ now: () => 5_000, randomBytes: () => fill(2) });
    expect(id).toBe(atRetryClock);
  });

  it('rejects a clock outside the 48-bit millisecond range before drawing entropy', () => {
    let draws = 0;
    const randomBytes = (): Uint8Array => {
      draws += 1;
      return fill(1);
    };
    for (const now of [
      () => -1,
      () => 1.5,
      () => Number.NaN,
      () => 2 ** 48,
      () => '1' as unknown as number,
    ]) {
      expect(codeOf(() => allocatePersonaId({ now, randomBytes }))).toBe('invalid_clock');
    }
    expect(draws).toBe(0);
  });

  it('propagates a clock exception unchanged', () => {
    const boom = new Error('clock stopped');
    expect(
      caught(() =>
        allocatePersonaId({
          now: () => {
            throw boom;
          },
        }),
      ),
    ).toBe(boom);
  });

  it('rejects a short, long, or non-byte entropy source before asking about occupancy', () => {
    let checks = 0;
    const isOccupied = (): boolean => {
      checks += 1;
      return false;
    };
    expect(
      codeOf(() =>
        allocatePersonaId({
          now: () => 0,
          randomBytes: () => new Uint8Array(9),
          isOccupied,
        }),
      ),
    ).toBe('invalid_entropy');
    expect(
      codeOf(() =>
        allocatePersonaId({
          now: () => 0,
          randomBytes: () => new Uint8Array(11),
          isOccupied,
        }),
      ),
    ).toBe('invalid_entropy');
    expect(
      codeOf(() =>
        allocatePersonaId({
          now: () => 0,
          randomBytes: () => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as unknown as Uint8Array,
          isOccupied,
        }),
      ),
    ).toBe('invalid_entropy');
    expect(checks).toBe(0);
  });

  it('asks the entropy source for exactly 10 bytes', () => {
    const sizes: number[] = [];
    allocateRunId({
      now: () => 0,
      randomBytes: (size) => {
        sizes.push(size);
        return fill(4);
      },
    });
    expect(sizes).toEqual([ID_ENTROPY_BYTES]);
  });

  it('does not let the occupancy callback mutate the entropy that was already drawn', () => {
    const buffer = fill(1);
    const id = allocatePersonaId({
      now: () => 0,
      randomBytes: () => buffer,
      isOccupied: () => {
        buffer.fill(9);
        return false;
      },
    });
    expect(id).toBe(allocatePersonaId({ now: () => 0, randomBytes: () => fill(1) }));
  });

  it('rejects options that are not a bag of functions', () => {
    expect(codeOf(() => allocatePersonaId(null as unknown as never))).toBe('invalid_argument');
    expect(isPersonaId(allocatePersonaId({ now: () => Date.now() }))).toBe(true);
    expect(codeOf(() => allocatePersonaId({ now: 1 as unknown as () => number }))).toBe(
      'invalid_argument',
    );
    expect(codeOf(() => allocatePersonaId({ randomBytes: 1 as unknown as () => Uint8Array }))).toBe(
      'invalid_argument',
    );
    expect(codeOf(() => allocatePersonaId({ isOccupied: 1 as unknown as () => boolean }))).toBe(
      'invalid_argument',
    );
  });
});

describe('allocator — collision retry', () => {
  it('returns the first free identifier and never the one the predicate rejected', () => {
    const taken = allocatePersonaId({ now: () => 50, randomBytes: () => fill(1) });
    const seen: string[] = [];
    const id = allocatePersonaId({
      now: () => 50,
      randomBytes: script([fill(1), fill(2)]),
      isOccupied: (candidate) => {
        seen.push(candidate);
        return candidate === taken;
      },
    });
    expect(seen).toEqual([taken, id]);
    expect(id).not.toBe(taken);
    expect(isPersonaId(id)).toBe(true);
  });

  it('uses a budget of 8 by default, and succeeds on the last try', () => {
    let draws = 0;
    const exhausted = caught(() =>
      allocateSessionId({
        now: () => 0,
        randomBytes: () => {
          draws += 1;
          return fill(draws);
        },
        isOccupied: () => true,
      }),
    );
    expect(draws).toBe(ID_ALLOCATION_MAX_ATTEMPTS);
    expect(isRuntimeError(exhausted)).toBe(true);
    if (isRuntimeError(exhausted)) {
      expect(exhausted.code).toBe('id_collision');
      expect(exhausted.details).toEqual({ prefix: 'ses', attempts: ID_ALLOCATION_MAX_ATTEMPTS });
      expect(exhausted.message).not.toMatch(/psn_|ses_|[0-9A-HJKMNP-TV-Z]{26}/u);
    }

    draws = 0;
    const id = allocateSessionId({
      now: () => 0,
      randomBytes: () => {
        draws += 1;
        return fill(draws);
      },
      isOccupied: () => draws < ID_ALLOCATION_MAX_ATTEMPTS,
    });
    expect(draws).toBe(ID_ALLOCATION_MAX_ATTEMPTS);
    expect(isSessionId(id)).toBe(true);
  });

  it('honours an explicit budget and stops at 1', () => {
    let draws = 0;
    const error = caught(() =>
      allocateTaskId({
        now: () => 0,
        randomBytes: () => {
          draws += 1;
          return fill(3);
        },
        isOccupied: () => true,
        maxAttempts: 1,
      }),
    );
    expect(draws).toBe(1);
    expect(isRuntimeError(error) && error.details).toEqual({ prefix: 'tsk', attempts: 1 });
  });

  it('does not loop when there is no occupancy predicate, even if a budget was passed', () => {
    let draws = 0;
    const id = allocateActionId({
      now: () => 0,
      maxAttempts: ID_ALLOCATION_MAX_ATTEMPTS,
      randomBytes: () => {
        draws += 1;
        return fill(6);
      },
    });
    expect(draws).toBe(1);
    expect(isActionId(id)).toBe(true);
  });

  it('rejects a non-boolean occupancy answer without retrying', () => {
    let draws = 0;
    const error = caught(() =>
      allocateEventId({
        now: () => 0,
        randomBytes: () => {
          draws += 1;
          return fill(1);
        },
        isOccupied: () => 1 as unknown as boolean,
      }),
    );
    expect(draws).toBe(1);
    expect(isRuntimeError(error) && error.code).toBe('invalid_argument');
  });

  it('propagates an occupancy exception; it is not a collision', () => {
    const boom = new Error('unique index unread');
    let draws = 0;
    const error = caught(() =>
      allocateEventId({
        now: () => 0,
        randomBytes: () => {
          draws += 1;
          return fill(1);
        },
        isOccupied: () => {
          throw boom;
        },
      }),
    );
    expect(error).toBe(boom);
    expect(draws).toBe(1);
    expect(isRuntimeError(error)).toBe(false);
  });

  it('rejects attempt budgets outside 1..128', () => {
    for (const maxAttempts of [0, -1, 1.5, 129, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(codeOf(() => allocatePersonaId({ now: () => 0, maxAttempts }))).toBe(
        'invalid_argument',
      );
    }
    expect(
      isPersonaId(
        allocatePersonaId({ now: () => 0, randomBytes: () => fill(1), maxAttempts: 128 }),
      ),
    ).toBe(true);
  });
});

describe('allocator — sqlite primary key backstop', () => {
  it('retries a taken primary key and does not replace the existing row', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE harness_ids (id TEXT PRIMARY KEY, marker TEXT NOT NULL)');
      const insert = db.prepare('INSERT INTO harness_ids (id, marker) VALUES (?, ?)');
      const lookup = db.prepare('SELECT marker FROM harness_ids WHERE id = ?');

      const clock = 1_700_000_000_000;
      const takenEntropy = fill(1);
      const freshEntropy = fill(2);
      const taken = allocatePersonaId({ now: () => clock, randomBytes: () => takenEntropy });
      insert.run(taken, 'original');

      const allocated = allocatePersonaId({
        now: () => clock,
        randomBytes: script([takenEntropy, freshEntropy]),
        isOccupied: (candidate) => {
          try {
            insert.run(candidate, 'claimed');
            return false;
          } catch (error) {
            const errcode = (error as { errcode?: unknown }).errcode;
            if (errcode === 1555 || errcode === 2067) {
              return true;
            }
            throw error;
          }
        },
      });

      expect(allocated).not.toBe(taken);
      expect(isPersonaId(allocated)).toBe(true);
      expect(lookup.get(taken)).toEqual({ marker: 'original' });
      expect(lookup.get(allocated)).toEqual({ marker: 'claimed' });

      let rejected = false;
      try {
        insert.run(taken, 'overwrite');
      } catch (error) {
        const errcode = (error as { errcode?: unknown }).errcode;
        rejected = errcode === 1555 || errcode === 2067;
      }
      expect(rejected).toBe(true);
      expect(lookup.get(taken)).toEqual({ marker: 'original' });
    } finally {
      db.close();
    }
  });

  it('leaves the original row alone when every attempt collides', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE harness_ids (id TEXT PRIMARY KEY, marker TEXT NOT NULL)');
      const insert = db.prepare('INSERT INTO harness_ids (id, marker) VALUES (?, ?)');
      const clock = 1_700_000_000_000;
      const taken = allocatePersonaId({ now: () => clock, randomBytes: () => fill(7) });
      insert.run(taken, 'original');

      const error = caught(() =>
        allocatePersonaId({
          now: () => clock,
          randomBytes: () => fill(7),
          maxAttempts: 3,
          isOccupied: (candidate) => {
            try {
              insert.run(candidate, 'new');
              return false;
            } catch (thrown) {
              const errcode = (thrown as { errcode?: unknown }).errcode;
              if (errcode === 1555 || errcode === 2067) {
                return true;
              }
              throw thrown;
            }
          },
        }),
      );
      expect(isRuntimeError(error) && error.code).toBe('id_collision');
      expect(db.prepare('SELECT marker FROM harness_ids WHERE id = ?').get(taken)).toEqual({
        marker: 'original',
      });
      expect(db.prepare('SELECT count(*) AS n FROM harness_ids').get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});

describe('allocator — surface and purity', () => {
  it('exports the allocator, persona lifecycle, and P1 ingress, not later surfaces', async () => {
    const exported = new Set(Object.keys(await import('../src/index.js')));
    expect(exported.has('createRuntime')).toBe(false);
    expect(exported.has('acceptStimulus')).toBe(false);
    expect(exported.has('createStimulusIngress')).toBe(true);
    expect(exported.has('enqueueTask')).toBe(false);
    expect(exported.has('recover')).toBe(false);
    expect(exported.has('checkpointAll')).toBe(false);
    expect(exported.has('allocatePersonaId')).toBe(true);
    expect(exported.has('allocateConflictRecordId')).toBe(true);
    expect(exported.has('createPersonaLifecycle')).toBe(true);
  });

  it('does not touch the filesystem, sqlite, or the environment from src', () => {
    const files = listTypeScript(SRC);
    expect(files.length).toBeGreaterThan(0);
    const forbidden = [
      'process.env',
      'node:sqlite',
      'node:fs',
      'node:net',
      'node:http',
      'node:child_process',
      "from 'fs'",
      'from "fs"',
      'require(',
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const needle of forbidden) {
        expect(source.includes(needle), `${file} contains ${needle}`).toBe(false);
      }
      for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu)) {
        const specifier = match[1] ?? '';
        const allowed =
          specifier.startsWith('.') ||
          specifier === 'node:crypto' ||
          specifier === '@soul-harness/contracts' ||
          specifier === '@soul-harness/persistence' ||
          specifier === 'ajv';
        expect(allowed, `${file} imports ${specifier}`).toBe(true);
      }
      for (const verb of ['SELECT ', 'INSERT ', 'UPDATE ', 'DELETE ', 'PRAGMA ']) {
        expect(source.includes(verb), `${file} contains ${verb}`).toBe(false);
      }
    }
  });

  it('types RuntimeError as its own class', () => {
    const error = new RuntimeError(
      'id_collision',
      'identifier allocation exhausted its retry budget',
      {
        details: { prefix: 'psn', attempts: 1 },
      },
    );
    expect(error.name).toBe('RuntimeError');
    expect(error).toBeInstanceOf(Error);
    expect(isRuntimeError(error)).toBe(true);
    expect(isRuntimeError(new Error('no'))).toBe(false);
    const bare = caught(() => allocateId('nope' as AllocatablePrefix));
    expect(isRuntimeError(bare) && bare.details).toBeUndefined();
  });

  it('can allocate with the production clock and entropy source', () => {
    const id = allocatePersonaId();
    expect(isPersonaId(id)).toBe(true);
    expect(id).toHaveLength(ID_TOTAL_LENGTH);
    expect(id.charAt(4)).toMatch(/[0-7]/u);
  });
});

function listTypeScript(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...listTypeScript(path));
    } else if (name.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}
