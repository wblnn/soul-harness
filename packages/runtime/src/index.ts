/**
 * @soul-harness/runtime — cognitive runtime.
 *
 * SH-008A: allocate the six core identities and the auxiliary `tsk` / `cnf`
 * forms. Clock, entropy, and occupancy are injectable. Collision retries, then
 * fails. It never overwrites and never accepts a caller-chosen id.
 *
 * SH-008B: in-process persona lifecycle on top of `@soul-harness/persistence`.
 * Create, query, start, suspend, resume, stop, restore by id, and normalize
 * STARTING / STOPPING to STOPPED. No epoch bump.
 *
 * What this package is NOT yet, and must not pretend to be:
 *   - no event bus, scheduler, recovery scans, or checkpoint load/save
 *   - no Daemon wiring and no HTTP surface
 *   - no SQL in this package; persistence owns every statement
 *   - no Archive, Action Gateway, or Dream Sandbox
 *   - no path that accepts an externally chosen internal id
 */

export { RUNTIME_ERROR_CODES, RuntimeError, isRuntimeError } from './errors.js';
export type { RuntimeErrorCode } from './errors.js';

export { PERSONA_DISPLAY_NAME_MAX_LENGTH, createPersonaLifecycle } from './persona/lifecycle.js';
export type {
  PersonaCommitView,
  PersonaLifecycle,
  PersonaLifecycleOptions,
  PersonaQuery,
  PersonaRuntimeSnapshot,
  PersonaSnapshot,
  RuntimeLogFields,
  RuntimeLogger,
} from './persona/lifecycle.js';

export {
  ALLOCATABLE_PREFIXES,
  ID_ALLOCATION_MAX_ATTEMPTS,
  ID_ENTROPY_BYTES,
  allocateActionId,
  allocateConflictRecordId,
  allocateEventId,
  allocateId,
  allocatePersonaId,
  allocateRunId,
  allocateSessionId,
  allocateTaskId,
  allocateThreadId,
} from './ids/allocate.js';
export type { AllocateOptions, AllocatablePrefix } from './ids/allocate.js';
