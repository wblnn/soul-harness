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
 * SH-008C: in-process P1 ingress. Validate the stimulus, dedupe without
 * comparing bodies, map sessions, commit the envelope, and hold the body in
 * a per-persona TTL buffer. No Archive, no HTTP, no scheduler.
 *
 * What this package is NOT yet, and must not pretend to be:
 *   - no scheduler, recovery scans, or checkpoint load/save
 *   - no Daemon wiring and no HTTP surface
 *   - no SQL in this package; persistence owns every statement
 *   - no Archive, Action Gateway, or Dream Sandbox
 *   - no path that accepts an externally chosen internal id
 *   - no claim that P1 `accepted` means audited, understood, or remembered
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

export { DEDUPE_BODY_UNVERIFIABLE_METRIC, createStimulusIngress } from './events/bus.js';
export type {
  AcceptStimulusInput,
  BufferedStimulus,
  IngressAccepted,
  IngressBackpressure,
  IngressChannelLimits,
  IngressDuplicate,
  IngressExpired,
  IngressMetrics,
  IngressPersistView,
  IngressRefused,
  IngressRejected,
  IngressResult,
  QueuedStimulus,
  StimulusIngress,
  StimulusIngressConfig,
  StimulusIngressOptions,
  TtlClose,
} from './events/bus.js';
export type { BufferCloseReason } from './events/bus.js';
export type { IngressScheduler, IngressTimer } from './events/buffer.js';
