/** Read-only task routes. No claim/dispatch/write endpoint is registered. */

import type { FastifyInstance } from 'fastify';

import { TASK_STATES } from '@soul-harness/persistence';

import type { DaemonApi } from '../daemon-api.js';
import { parseEnum, parseListLimit, parsePersonaId } from '../http/limits.js';

export function registerTaskReadRoutes(app: FastifyInstance, api: DaemonApi): void {
  app.get('/v1/personas/:personaId/tasks', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const query = request.query as Record<string, unknown>;
    const personaId = parsePersonaId(params['personaId']);
    const state = parseEnum(query['state'], TASK_STATES);
    const limit = parseListLimit(query['limit']);
    return reply.code(200).send({
      tasks: api.listTasks({
        personaId,
        ...(state === undefined ? {} : { state }),
        limit,
      }),
    });
  });
}
