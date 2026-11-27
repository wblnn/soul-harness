/**
 * Structured logging.
 *
 * One JSON object per line. Rules (RUNTIME-LIFECYCLE §2 step 2, TRUST-BOUNDARIES
 * §11.3): no event content, no memory content, no model input/output, no tokens
 * or keys — and no way to smuggle them in through an exception stack, a nested
 * object, or a field name the daemon does not use.
 *
 * Field names are default-deny. A key is written only when it is on the
 * operational allowlist; every other key is dropped entirely, including its
 * name, so a secret cannot be published through the key itself. Allowlisted
 * keys whose names still look like content (`token`, `content`, `payload`, …)
 * are redacted too.
 *
 * A matching name is not enough for a value that can come from outside the
 * process. `source` and `adapterId` stay redacted until the adapter registry
 * exists — a shape check is not that registry. `adapterEventRef` is written
 * only as a short hash. `reason` and `code` must be fixed operational codes.
 * `event` must be one of the events this process actually emits; a lookalike
 * such as a forged `daemon_stopped` variant is replaced with `invalid_event`
 * and the original text is dropped. Every other string has to match the rule
 * for that key. A string with no rule is redacted.
 *
 * `error` is written only for an `Error` instance, reduced to
 * `{ name, code, message: '[redacted]' }`. `name` and `code` come from closed
 * sets. A plain object is not walked, so `{ code: "..." }` cannot leave a free
 * string in the log through an allowlisted nested key. `Error.message` is
 * untrusted free text, and a plain string field named `message` is not
 * allowlisted, so neither path writes it.
 */

import { createHash } from 'node:crypto';

import type { LogLevel } from './config.js';

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  readonly level: LogLevel;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly sink?: (line: string) => void;
  readonly now?: () => Date;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Operational fields the daemon and the runtime actually emit.
 * Any other name is omitted. The name is not copied into the line: a caller
 * can put the secret in the field name itself.
 */
const ALLOWED_LOG_KEYS: ReadonlySet<string> = new Set([
  'acceptsInput',
  'adapterEventRef',
  'adapterId',
  'applied',
  'attempt',
  'batchSize',
  'bodyVerified',
  'bootId',
  'cleanupFailures',
  'code',
  'currentVersion',
  'dataDir',
  'databaseFile',
  'drained',
  'epoch',
  'error',
  'eventBus',
  'eventId',
  'eventIngress',
  'eventsExpired',
  'expectedVersion',
  'expired',
  'failed',
  'from',
  'handlers',
  'healthEndpoint',
  'httpApi',
  'lockPath',
  'lockPid',
  'logLevel',
  'maxAttempts',
  'maxConcurrentTotal',
  'maxPersonasPerRun',
  'maxProbeQueries',
  'maxRowsPerRun',
  'maxScanQueries',
  'metric',
  'normalized',
  'operation',
  'owner',
  'pending',
  'perPersonaChannelConcurrency',
  'personaAdmissionCapacity',
  'personaId',
  'personaLifecycle',
  'personaWaiting',
  'personas',
  'personasScanned',
  'phase',
  'pid',
  'probed',
  'probes',
  'queueCapacity',
  'reason',
  'receivedAt',
  'requeued',
  'runtimeRecovery',
  'scanned',
  'scheduler',
  'schema',
  'sessionId',
  'shutdownTimeoutMs',
  'signal',
  'source',
  'sourceWaiting',
  'state',
  'status',
  'step',
  'taskDispatch',
  'taskId',
  'tasksFailed',
  'tasksRequeued',
  'to',
  'transport',
  'unit',
  'version',
]);

/** Allowlisted names that still must never carry a value. */
const REDACTED_KEY =
  /(token|secret|password|passwd|apikey|api_key|credential|content|payload|prompt|transcript|memory|body)/iu;

const REDACTED = '[redacted]';
const INVALID_EVENT = 'invalid_event';
const MAX_DEPTH = 4;
const MAX_ARRAY = 20;

/**
 * Events the daemon and the runtime emit. A regex-legal name that is not in
 * this set is not an event, even when it looks like `daemon_stopped`.
 * Kept here, not imported, so a caller cannot widen the set by passing a string.
 */
const ALLOWED_EVENTS: ReadonlySet<string> = new Set([
  'boot_aborted',
  'boot_failed',
  'boot_started',
  'checkpoint_skipped',
  'cleanup_failed',
  'consumer.handler',
  'daemon_running',
  'daemon_stopped',
  'drain_started',
  'event_bus_start_failed',
  'fatal',
  'ingress.accepted',
  'ingress.admission_backpressure',
  'ingress.buffer_failed',
  'ingress.buffer_rearm_failed',
  'ingress.dedupe_unverifiable',
  'ingress.post_commit_failed',
  'ingress.processing_failed',
  'ingress.queue_overflow',
  'ingress.schema_invalid',
  'ingress.ttl_expired',
  'ingress.ttl_failed',
  'ingress.ttl_persist_failed',
  'ingress.ttl_retry_failed',
  'ingress.ttl_retry_unscheduled',
  'persona.created',
  'persona.transition',
  'persona.transition_rejected',
  'persona.version_conflict',
  'persona_recovery_failed',
  'phase_entered',
  'recovery_completed',
  'recovery_incomplete',
  'recovery_probe',
  'recovery_started',
  'resume_cas_inconsistency',
  'runtime_recovery_failed',
  'scheduler_clock_failed',
  'scheduler_created',
  'scheduler_handler_failed',
  'scheduler_invalid_claim',
  'scheduler_late_result_discarded',
  'scheduler_settle_abandoned',
  'scheduler_settle_backpressure',
  'scheduler_settle_conflict',
  'scheduler_settle_failed',
  'scheduler_settle_recovered',
  'scheduler_start_failed',
  'scheduler_started',
  'scheduler_stopped',
  'scheduler_stopping',
  'scheduler_tick_failed',
  'scheduler_timer_failed',
  'scheduler_unhandled_kind',
  'signal_received',
  'step_ok',
  'step_skipped',
]);

/**
 * `code` values the daemon, persistence, and runtime assign. `unknown` and
 * `clock_failed` are the scheduler's own synthetic codes, not caller text.
 */
const ALLOWED_CODES: ReadonlySet<string> = new Set([
  'api_token_invalid',
  'api_token_insecure',
  'api_token_io_failed',
  'async_callback_unsupported',
  'check_violation',
  'checkpoint_epoch_mismatch',
  'checkpoint_invalid',
  'checkpoint_version_unsupported',
  'clock_failed',
  'closed',
  'concurrent_modification',
  'config_invalid',
  'config_missing',
  'data_dir_invalid',
  'data_dir_unwritable',
  'db_error',
  'event_bus_start_failed',
  'foreign_key_violation',
  'http_api_start_failed',
  'id_collision',
  'id_encoding',
  'illegal_task_row',
  'illegal_transition',
  'invalid_argument',
  'invalid_clock',
  'invalid_column_value',
  'invalid_entropy',
  'invalid_field_name',
  'invalid_identifier',
  'invalid_json_column',
  'invalid_transition',
  'lock_acquire_failed',
  'lock_held',
  'lock_release_failed',
  'lock_unreadable',
  'migration_checksum_mismatch',
  'migration_duplicate_version',
  'migration_failed',
  'migration_name_invalid',
  'migration_not_found',
  'migration_out_of_order',
  'nested_write',
  'not_found',
  'not_null_violation',
  'persona_recovery_failed',
  'pragma_not_applied',
  'read_only_violation',
  'recovery_incomplete',
  'runtime_recovery_failed',
  'runtime_state_missing',
  'scheduler_start_failed',
  'schema_invalid',
  'schema_mismatch',
  'shutdown_failed',
  'startup_aborted',
  'startup_failed',
  'statement_blocked',
  'store_closed',
  'store_open_failed',
  'store_unusable',
  'task_exhausted',
  'transaction_closed',
  'unique_conflict',
  'unknown',
  'version_conflict',
]);

const ALLOWED_PHASES: ReadonlySet<string> = new Set([
  'BOOTING',
  'CHECKPOINTING',
  'CLOSING',
  'DRAINING',
  'FAILED',
  'MIGRATING',
  'READY',
  'RECOVERING',
  'RUNNING',
  'STOPPED',
]);

const ALLOWED_STEPS: ReadonlySet<string> = new Set([
  'config',
  'data_directory',
  'event_bus',
  'health_check',
  'http_api',
  'instance_lock',
  'logging',
  'migrations',
  'persona_recovery',
  'runtime_recovery',
  'scheduler',
  'scheduler_drain',
  'schema_verification',
  'sqlite_open',
]);

const ALLOWED_STATUSES: ReadonlySet<string> = new Set([
  'accepted',
  'acted',
  'expired',
  'failed',
  'implemented',
  'noticed',
  'not_implemented',
  'ok',
  'received',
  'rejected',
  'response_committed',
  'understood',
]);

const ALLOWED_STATES: ReadonlySet<string> = new Set([
  'CREATED',
  'FAILED',
  'RUNNING',
  'STARTING',
  'STOPPED',
  'STOPPING',
  'SUSPENDED',
  'absent',
  'cancelled',
  'created',
  'done',
  'failed',
  'paused',
  'queued',
  'running',
  'stopped',
  'stopping',
]);

const ENUM_VALUES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['code', ALLOWED_CODES],
  ['eventBus', new Set(['assembled_no_transport', 'not_implemented'])],
  ['eventIngress', new Set(['not_implemented', 'unavailable_no_transport'])],
  [
    'from',
    new Set(['CREATED', 'FAILED', 'RUNNING', 'STARTING', 'STOPPED', 'STOPPING', 'SUSPENDED']),
  ],
  [
    'healthEndpoint',
    new Set([
      'not_implemented',
      'assembled',
      'running',
      'draining',
      'stopped',
      'failed',
      'unavailable',
      'available',
    ]),
  ],
  [
    'httpApi',
    new Set([
      'not_implemented',
      'assembled',
      'running',
      'draining',
      'stopped',
      'failed',
      'unavailable',
      'available',
    ]),
  ],
  ['logLevel', new Set(['debug', 'info', 'warn', 'error'])],
  ['metric', new Set(['dedupe.body_unverifiable'])],
  ['operation', new Set(['normalize', 'resume', 'start', 'stop', 'suspend'])],
  ['owner', new Set(['SH-008', 'SH-009', 'unassigned'])],
  ['personaLifecycle', new Set(['assembled', 'not_implemented'])],
  ['phase', ALLOWED_PHASES],
  ['runtimeRecovery', new Set(['assembled', 'not_implemented'])],
  ['scheduler', new Set(['not_implemented', 'running'])],
  ['schema', new Set(['soul.stimulus.input.v1'])],
  ['signal', new Set(['SIGINT', 'SIGTERM'])],
  ['state', ALLOWED_STATES],
  ['status', ALLOWED_STATUSES],
  ['step', ALLOWED_STEPS],
  ['taskDispatch', new Set(['not_implemented', 'unavailable_no_handlers'])],
  ['to', new Set(['CREATED', 'FAILED', 'RUNNING', 'STARTING', 'STOPPED', 'STOPPING', 'SUSPENDED'])],
  ['transport', new Set(['none'])],
  ['unit', new Set(['U1', 'U2', 'U3', 'U4', 'U4b', 'U5a', 'U5r', 'U6c', 'U6n', 'U6u'])],
]);

/** Same shapes as the contracts patterns. Duplicated so this file does not import them. */
const ID_PATTERNS: ReadonlyMap<string, RegExp> = new Map([
  ['bootId', /^[A-Za-z0-9._:-]{1,64}$/u],
  ['eventId', /^evt_[0-9A-HJKMNP-TV-Z]{26}$/u],
  ['personaId', /^psn_[0-9A-HJKMNP-TV-Z]{26}$/u],
  ['sessionId', /^ses_[0-9A-HJKMNP-TV-Z]{26}$/u],
  ['taskId', /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/u],
]);

const PATH_KEYS: ReadonlySet<string> = new Set(['dataDir', 'databaseFile', 'lockPath']);

function isPath(value: string): boolean {
  if (value.length < 1 || value.length > 4096) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) {
      return false;
    }
  }
  return true;
}

/**
 * Adapter-side stimulus reference. Same shape as the contracts pattern: opaque,
 * and too narrow to carry prose. The raw value is still not logged.
 */
const ADAPTER_EVENT_REF = /^[A-Za-z0-9._:-]{1,64}$/u;

const ERROR_NAMES: ReadonlySet<string> = new Set([
  'AggregateError',
  'DaemonError',
  'Error',
  'EvalError',
  'PersistenceError',
  'RangeError',
  'ReferenceError',
  'RuntimeError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

function eventName(event: string): string {
  return ALLOWED_EVENTS.has(event) ? event : INVALID_EVENT;
}

function adapterEventRef(value: unknown): string {
  if (typeof value !== 'string' || !ADAPTER_EVENT_REF.test(value)) {
    return REDACTED;
  }
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `ref_${digest}`;
}

function stringValue(key: string, value: string): string {
  if (key === 'reason') {
    return ALLOWED_REASONS.has(value) ? value : REDACTED;
  }
  const allowed = ENUM_VALUES.get(key);
  if (allowed !== undefined) {
    return allowed.has(value) ? value : REDACTED;
  }
  const id = ID_PATTERNS.get(key);
  if (id !== undefined) {
    return id.test(value) ? value : REDACTED;
  }
  if (PATH_KEYS.has(key)) {
    return isPath(value) ? value : REDACTED;
  }
  return REDACTED;
}

function errorValue(error: Error): { name: string; code?: string; message: string } {
  const code = (error as { code?: unknown }).code;
  return {
    name: ERROR_NAMES.has(error.name) ? error.name : REDACTED,
    ...(typeof code === 'string' ? { code: ALLOWED_CODES.has(code) ? code : REDACTED } : {}),
    message: REDACTED,
  };
}

function sanitizeValue(value: unknown, depth: number, key?: string): unknown {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : REDACTED;
  }
  if (typeof value === 'string') {
    return key === undefined ? REDACTED : stringValue(key, value);
  }
  if (value instanceof Error) {
    return key === 'error' ? errorValue(value) : REDACTED;
  }
  if (depth >= MAX_DEPTH) {
    return '[depth-limit]';
  }
  if (Array.isArray(value)) {
    const visible = value.slice(0, MAX_ARRAY).map((entry) => sanitizeValue(entry, depth + 1));
    return value.length > MAX_ARRAY ? [...visible, `[+${value.length - MAX_ARRAY} more]`] : visible;
  }
  if (typeof value === 'object') {
    return sanitizeRecord(value as Record<string, unknown>, depth + 1);
  }
  return REDACTED;
}

function sanitizeRecord(record: Record<string, unknown>, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!ALLOWED_LOG_KEYS.has(key)) {
      // Drop the property. Keeping the name with a redacted value would still
      // publish a secret that was placed in the key.
      continue;
    }
    if (key === 'source' || key === 'adapterId') {
      // No adapter registry is implemented. A pattern match is not registration.
      result[key] = REDACTED;
      continue;
    }
    if (key === 'adapterEventRef') {
      result[key] = adapterEventRef(value);
      continue;
    }
    if (key === 'error') {
      // A plain object is not an error. Walking it would publish allowlisted
      // nested keys (`code`) as free strings.
      result[key] = value instanceof Error ? errorValue(value) : REDACTED;
      continue;
    }
    if (REDACTED_KEY.test(key)) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = sanitizeValue(value, depth, key);
  }
  return result;
}

/**
 * Reasons the daemon and the runtime emit. A free-text stop reason or an
 * external string is not in this set. Step notes are the fixed strings from
 * the lifecycle table, not caller input.
 */
const ALLOWED_REASONS: ReadonlySet<string> = new Set([
  'SIGINT',
  'SIGTERM',
  'aborted',
  'archive_conflict',
  'archive_state_present',
  'archive_unavailable',
  'auth_failed',
  'buffer_lost',
  'concurrent_modification',
  'explicit env config, no fallbacks',
  'in-process ingress only; no transport and no external input',
  'invalid_task_row',
  'loopback API/WebSocket not implemented',
  'no health transport; status is available in-process only',
  'no transport receives events yet',
  'no work is dispatched',
  'normalize crashed personas; nothing is auto-started',
  'not_implemented',
  'persona_budget_exceeded',
  'probe_budget_exceeded',
  'processing_failed',
  'queue_overflow',
  'rate_limited',
  'recoverRuntime is fail-closed; no scheduler in this phase',
  'requested',
  'row_budget_exceeded',
  'running with an empty handler map; tasks are not dispatched',
  'runtime_not_implemented',
  'scan_query_budget_exceeded',
  'schema_invalid',
  'startup_failed',
  'stop_requested',
  'ttl_expired',
  'unexpected_event_status',
  'untrusted_source',
  'atomic, data-dir scoped, owner-checked release',
  'directory + real write probe, no temp fallback',
  'expected P1 shape, column order included',
  'packaged migrations, checksum verified',
  'single writer, WAL',
  'structured JSON lines, content redacted',
]);

/** Builds a logger writing one JSON line per record. */
export function createLogger(options: LoggerOptions): Logger {
  const sink =
    options.sink ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const now = options.now ?? ((): Date => new Date());

  const emit = (level: LogLevel, bindings: LogFields, event: string, fields?: LogFields): void => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[options.level]) {
      return;
    }
    const record: Record<string, unknown> = {
      ts: now().toISOString(),
      level,
      event: eventName(event),
      ...sanitizeRecord(bindings, 0),
      ...sanitizeRecord(fields ?? {}, 0),
    };
    sink(JSON.stringify(record));
  };

  const make = (bindings: LogFields): Logger => ({
    level: options.level,
    debug: (event, fields) => emit('debug', bindings, event, fields),
    info: (event, fields) => emit('info', bindings, event, fields),
    warn: (event, fields) => emit('warn', bindings, event, fields),
    error: (event, fields) => emit('error', bindings, event, fields),
    child: (extra) => make({ ...bindings, ...extra }),
  });

  return make({ pid: process.pid });
}
