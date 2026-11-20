/**
 * Repository set.
 *
 * One factory per table keeps the surface explicit; `createRepositories` is the
 * convenience entry point for callers that need several of them. Repositories
 * never expose the database handle, and every write goes through `withWrite`.
 */

import type { Store } from '../db/store.js';
import { createCheckpointRepository } from './checkpoint.js';
import { createEventRepository } from './events.js';
import { createPersonaRepository } from './personas.js';
import { createRuntimeStateRepository } from './runtime-state.js';
import { createSchemaMigrationsRepository } from './schema-migrations.js';
import { createSessionRepository } from './sessions.js';
import { createTaskRepository } from './tasks.js';

export { createCheckpointRepository } from './checkpoint.js';
export type {
  CheckpointLoadResult,
  CheckpointRepository,
  SaveCheckpointInput,
  StoredCheckpoint,
} from './checkpoint.js';

export { createPersonaRepository } from './personas.js';
export type {
  CommitPersonaLifecycleInput,
  CommittedPersonaLifecycle,
  InsertPersonaInput,
  PersonaRepository,
  UpdatePersonaStateInput,
} from './personas.js';

export { createSessionRepository } from './sessions.js';
export type { CloseSessionInput, InsertSessionInput, SessionRepository } from './sessions.js';

export { createEventRepository } from './events.js';
export type { EventRepository, InsertEventInput, UpdateEventStatusInput } from './events.js';

export { createTaskRepository } from './tasks.js';
export type { InsertTaskInput, TaskRepository, UpdateTaskStateInput } from './tasks.js';

export { createRuntimeStateRepository } from './runtime-state.js';
export type { RuntimeStateRepository, UpsertRuntimeStateInput } from './runtime-state.js';

export { createSchemaMigrationsRepository } from './schema-migrations.js';
export type { SchemaMigrationsRepository } from './schema-migrations.js';

export { DEFAULT_LIST_LIMIT, JSON_SCHEMA_IDS, MAX_LIST_LIMIT } from './shared.js';

export function createRepositories(store: Store) {
  return {
    personas: createPersonaRepository(store),
    sessions: createSessionRepository(store),
    events: createEventRepository(store),
    tasks: createTaskRepository(store),
    runtimeState: createRuntimeStateRepository(store),
    checkpoints: createCheckpointRepository(store),
    schemaMigrations: createSchemaMigrationsRepository(store),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
