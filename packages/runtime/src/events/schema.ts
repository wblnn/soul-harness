/**
 * Stimulus schema gate (SH-008C).
 *
 * The adapter document is checked against the contracts schema
 * `soul.stimulus.input.v1`. That schema is closed, so `receivedAt` and any
 * other unknown top-level field fail here. Ingress then stamps `receivedAt`
 * and checks the result against `soul.stimulus.v1`.
 *
 * Ajv error objects are dropped immediately. They can point at the payload,
 * and the payload must not be retained by the validator or copied into a
 * RuntimeError.
 */

import { Ajv, type ValidateFunction } from 'ajv';

import {
  STIMULUS_INPUT_VERSION,
  STIMULUS_VERSION,
  stimulusInputV1Schema,
  stimulusV1Schema,
} from '@soul-harness/contracts';
import type { StimulusInputV1, StimulusPayload, StimulusV1 } from '@soul-harness/contracts';

import { RuntimeError } from '../errors.js';

const ajv = new Ajv({ allErrors: false, strict: true });

const validateInput: ValidateFunction = ajv.compile(
  stimulusInputV1Schema as unknown as Record<string, unknown>,
);
const validateNormalized: ValidateFunction = ajv.compile(
  stimulusV1Schema as unknown as Record<string, unknown>,
);

function matches(validate: ValidateFunction, value: unknown): boolean {
  const ok = validate(value) === true;
  validate.errors = null;
  return ok;
}

/**
 * Accepts only a document that is a closed `soul.stimulus.input.v1` envelope.
 *
 * The returned value is a deep copy. Later writes to the caller's object do
 * not change the persona, the dedupe key, or the payload that will be queued.
 */
export function parseStimulusInput(value: unknown): StimulusInputV1 {
  if (!matches(validateInput, value)) {
    throw new RuntimeError('schema_invalid', 'stimulus failed schema validation', {
      details: { schema: STIMULUS_INPUT_VERSION },
    });
  }
  let cloned: unknown;
  try {
    cloned = structuredClone(value);
  } catch (error) {
    throw new RuntimeError('schema_invalid', 'stimulus could not be snapshotted', {
      cause: error,
      details: { schema: STIMULUS_INPUT_VERSION },
    });
  }
  return cloned as StimulusInputV1;
}

/**
 * Stamps `receivedAt` and returns the normalized envelope.
 *
 * The payload is cloned first so a later mutation of the caller's object
 * cannot change the buffered copy, and cannot change the bytes the schema
 * just accepted.
 */
export function normalizeStimulus(input: StimulusInputV1, receivedAt: number): StimulusV1 {
  let payload: StimulusPayload;
  try {
    payload = structuredClone(input.payload);
  } catch (error) {
    throw new RuntimeError('schema_invalid', 'stimulus payload could not be buffered', {
      cause: error,
      details: { schema: STIMULUS_INPUT_VERSION },
    });
  }

  const normalized: StimulusV1 = {
    schema: STIMULUS_VERSION,
    personaId: input.personaId,
    adapterId: input.adapterId,
    source: input.source,
    adapterEventRef: input.adapterEventRef,
    requestNonce: input.requestNonce,
    payload,
    receivedAt,
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
  };

  if (!matches(validateNormalized, normalized)) {
    throw new RuntimeError('schema_invalid', 'normalized stimulus failed schema validation', {
      details: { schema: STIMULUS_VERSION },
    });
  }
  freezeDeep(normalized);
  return normalized;
}

/** Freeze the snapshot so a queued envelope cannot be edited in place. */
function freezeDeep(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return;
  }
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      freezeDeep(item);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    freezeDeep((value as Record<string, unknown>)[key]);
  }
}
