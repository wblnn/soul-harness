/**
 * Per-persona TTL buffer (SH-008C).
 *
 * The stimulus body lives only in this map. Nothing here writes a database,
 * a checkpoint, or a log. Each persona has its own map; a lookup never
 * crosses that boundary.
 *
 * Timers are cancellable. `clear` drops every body and every handle. A long
 * TTL is sliced so a single timer delay stays inside the platform range, and
 * the slice reschedules until `expiresAt`.
 *
 * `put` and `rearm` do not leave a body behind when `schedule` throws. The
 * slot is removed before the error leaves this module.
 */

import type { EventId, PersonaId, SourceId, StimulusPayload } from '@soul-harness/contracts';

/** Largest delay `setTimeout` accepts without wrapping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface IngressTimer {
  cancel(): void;
}

export interface IngressScheduler {
  schedule(delayMs: number, fire: () => void): IngressTimer;
}

export function createDefaultIngressScheduler(): IngressScheduler {
  return {
    schedule(delayMs, fire) {
      const handle = setTimeout(fire, delayMs);
      return {
        cancel() {
          clearTimeout(handle);
        },
      };
    },
  };
}

export interface BufferSlot {
  readonly personaId: PersonaId;
  readonly eventId: EventId;
  readonly source: SourceId;
  readonly receivedAt: number;
  readonly occurredAt: number | null;
  readonly expiresAt: number;
  readonly payload: StimulusPayload;
}

export interface PerceptionBuffer {
  put(
    slot: BufferSlot,
    onDue: (slot: BufferSlot) => void,
    onUnarmed: (slot: BufferSlot) => void,
  ): void;
  peek(personaId: PersonaId, eventId: EventId): BufferSlot | null;
  /** Occupied slots for one persona and one source, including ones already due. */
  count(personaId: PersonaId, source: SourceId): number;
  list(personaId: PersonaId): readonly BufferSlot[];
  due(personaId: PersonaId, now: number): readonly BufferSlot[];
  dueAll(now: number): readonly BufferSlot[];
  /** Drops the body and cancels its timer. */
  take(personaId: PersonaId, eventId: EventId): BufferSlot | null;
  rearm(personaId: PersonaId, eventId: EventId): void;
  clear(): void;
}

interface Held {
  readonly slot: BufferSlot;
  onDue: (slot: BufferSlot) => void;
  onUnarmed: (slot: BufferSlot) => void;
  timer: IngressTimer | null;
}

export function createPerceptionBuffer(options: {
  readonly now: () => number;
  readonly scheduler: IngressScheduler;
}): PerceptionBuffer {
  const byPersona = new Map<string, Map<string, Held>>();

  function personaMap(personaId: string): Map<string, Held> {
    const existing = byPersona.get(personaId);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Map<string, Held>();
    byPersona.set(personaId, created);
    return created;
  }

  function lookup(personaId: string, eventId: string): Held | null {
    return byPersona.get(personaId)?.get(eventId) ?? null;
  }

  function forgetPersonaIfEmpty(personaId: string, slots: Map<string, Held>): void {
    if (slots.size === 0) {
      byPersona.delete(personaId);
    }
  }

  function dropHeld(held: Held): void {
    const slots = byPersona.get(held.slot.personaId);
    if (slots?.get(held.slot.eventId) !== held) {
      return;
    }
    held.timer?.cancel();
    held.timer = null;
    slots.delete(held.slot.eventId);
    forgetPersonaIfEmpty(held.slot.personaId, slots);
  }

  function arm(held: Held): void {
    held.timer?.cancel();
    held.timer = null;
    const remaining = held.slot.expiresAt - options.now();
    const delay = remaining <= 0 ? 0 : Math.min(remaining, MAX_TIMER_DELAY_MS);
    const timer = options.scheduler.schedule(delay, () => {
      try {
        const current = lookup(held.slot.personaId, held.slot.eventId);
        if (current !== held) {
          return;
        }
        held.timer = null;
        const due = held.slot.expiresAt <= options.now();
        if (due) {
          held.onDue(held.slot);
          return;
        }
        arm(held);
      } catch {
        // A failed re-arm or a clock read must not escape the timer callback,
        // and must not leave a body with no timer.
        dropHeld(held);
        try {
          held.onUnarmed(held.slot);
        } catch {
          // The owner is responsible for its own logging. The callback stops here.
        }
      }
    });
    held.timer = timer;
  }

  return {
    put(slot, onDue, onUnarmed) {
      const slots = personaMap(slot.personaId);
      const previous = slots.get(slot.eventId);
      previous?.timer?.cancel();
      const held: Held = { slot, onDue, onUnarmed, timer: null };
      slots.set(slot.eventId, held);
      try {
        arm(held);
      } catch (error) {
        if (slots.get(slot.eventId) === held) {
          held.timer?.cancel();
          held.timer = null;
          slots.delete(slot.eventId);
          forgetPersonaIfEmpty(slot.personaId, slots);
        }
        throw error;
      }
    },

    peek(personaId, eventId) {
      return lookup(personaId, eventId)?.slot ?? null;
    },

    count(personaId, source) {
      const slots = byPersona.get(personaId);
      if (slots === undefined) {
        return 0;
      }
      let count = 0;
      for (const held of slots.values()) {
        if (held.slot.source === source) {
          count += 1;
        }
      }
      return count;
    },

    list(personaId) {
      const slots = byPersona.get(personaId);
      if (slots === undefined) {
        return [];
      }
      return [...slots.values()]
        .map((held) => held.slot)
        .sort((left, right) => {
          if (left.receivedAt !== right.receivedAt) {
            return left.receivedAt < right.receivedAt ? -1 : 1;
          }
          if (left.eventId === right.eventId) {
            return 0;
          }
          return left.eventId < right.eventId ? -1 : 1;
        });
    },

    due(personaId, now) {
      const slots = byPersona.get(personaId);
      if (slots === undefined) {
        return [];
      }
      const dueSlots: BufferSlot[] = [];
      for (const held of slots.values()) {
        if (held.slot.expiresAt <= now) {
          dueSlots.push(held.slot);
        }
      }
      return dueSlots;
    },

    dueAll(now) {
      const dueSlots: BufferSlot[] = [];
      for (const slots of byPersona.values()) {
        for (const held of slots.values()) {
          if (held.slot.expiresAt <= now) {
            dueSlots.push(held.slot);
          }
        }
      }
      return dueSlots;
    },

    take(personaId, eventId) {
      const slots = byPersona.get(personaId);
      if (slots === undefined) {
        return null;
      }
      const held = slots.get(eventId);
      if (held === undefined) {
        return null;
      }
      held.timer?.cancel();
      held.timer = null;
      slots.delete(eventId);
      forgetPersonaIfEmpty(personaId, slots);
      return held.slot;
    },

    rearm(personaId, eventId) {
      const held = lookup(personaId, eventId);
      if (held === null) {
        return;
      }
      try {
        arm(held);
      } catch (error) {
        const slots = byPersona.get(personaId);
        if (slots?.get(eventId) === held) {
          held.timer?.cancel();
          held.timer = null;
          slots.delete(eventId);
          forgetPersonaIfEmpty(personaId, slots);
        }
        throw error;
      }
    },

    clear() {
      for (const slots of byPersona.values()) {
        for (const held of slots.values()) {
          held.timer?.cancel();
          held.timer = null;
        }
      }
      byPersona.clear();
    },
  };
}
