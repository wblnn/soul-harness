/**
 * @soul-harness/persistence — SQLite storage foundation.
 *
 * What this package IS:
 *   - store lifecycle (open / close) with the documented pragmas
 *   - migrations: loading, checksum verification, transactional execution
 *   - schema verification against the expected P1 shape
 *   - transactions (`withWrite` / `withRead`), field mapping, checkpoints (C)
 *   - repositories for the six P1 tables
 *
 * What this package is NOT and must never become:
 *   - no business semantics: it never decides whether an event matters, whether
 *     something should be remembered, or what the persona should do
 *   - no Archive access, no Archive keys, no decryption
 *   - no direct exposure of the SQLite handle to other packages
 *   - no raw stimulus content in any long-lived table
 */

export { openStore } from './db/open-store.js';
export type { OpenStoreOptions } from './db/open-store.js';
export { Store } from './db/store.js';

export { PERSISTENCE_ERROR_CODES, PersistenceError, isPersistenceError } from './errors.js';
export type { PersistenceErrorCode } from './errors.js';

export { defaultMigrationsDir, migrate, verifySchema } from './migrations/migrator.js';
export {
  checksumOfSql,
  createMigrationFile,
  loadMigrationsFromDir,
  normalizeMigrations,
  normalizeSqlText,
} from './migrations/load.js';
export { P1_INDEXES, P1_TABLE_COLUMNS } from './migrations/expected-schema.js';
export type { P1TableName } from './migrations/expected-schema.js';
export type {
  AppliedMigration,
  MigrateOptions,
  MigrateResult,
  MigrationFile,
} from './migrations/types.js';

export { isStoreUnusable, withRead, withWrite } from './tx/coordinator.js';
export type { NotPromise, ReadTx, Tx } from './tx/coordinator.js';
export { firstKeyword } from './tx/statements.js';
export type { GuardedStatement, StatementRunResult } from './tx/statements.js';

export {
  JSON_COLUMN_SCHEMA_KEY,
  camelizeRow,
  decodeJsonColumn,
  encodeJsonColumn,
  fromDbBoolean,
  isMappedPair,
  toCamelCase,
  toDbBoolean,
  toSnakeCase,
} from './mapping.js';

export {
  createRepositories,
  createCheckpointRepository,
  createEventRepository,
  createPersonaRepository,
  createRuntimeStateRepository,
  createSchemaMigrationsRepository,
  createSessionRepository,
  createTaskRepository,
  DEFAULT_LIST_LIMIT,
  JSON_SCHEMA_IDS,
  MAX_LIST_LIMIT,
} from './repositories/index.js';
export type {
  CheckpointLoadResult,
  CheckpointRepository,
  CommitPersonaLifecycleInput,
  CommittedPersonaLifecycle,
  EventRepository,
  InsertEventInput,
  InsertPersonaInput,
  InsertSessionInput,
  InsertTaskInput,
  PersonaRepository,
  Repositories,
  RuntimeStateRepository,
  SaveCheckpointInput,
  SchemaMigrationsRepository,
  SessionRepository,
  StoredCheckpoint,
  TaskRepository,
  UpdateEventStatusInput,
  UpdatePersonaStateInput,
  UpdateTaskStateInput,
  UpsertRuntimeStateInput,
  CloseSessionInput,
} from './repositories/index.js';

export {
  CHECKPOINT_CURSOR_PATTERN,
  CHECKPOINT_MAX_BYTES,
  CHECKPOINT_MAX_REFS,
  CHECKPOINT_SCHEMA,
  CHECKPOINT_VERSION,
  decodeCheckpoint,
  encodeCheckpoint,
  isOpaqueCursor,
} from './checkpoint/format.js';
export type { Checkpoint, CheckpointRefs } from './checkpoint/format.js';

export { PERSONA_STATES, TASK_STATES } from './types/rows.js';
export type {
  AppliedMigrationRow,
  EventRow,
  PersonaRow,
  PersonaState,
  RuntimeStateRow,
  SessionRow,
  TaskRow,
  TaskState,
} from './types/rows.js';
