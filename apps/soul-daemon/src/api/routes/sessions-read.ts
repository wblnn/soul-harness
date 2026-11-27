/** Read-only session routes. */

import type { FastifyInstance } from 'fastify';

import type { DaemonApi } from '../daemon-api.js';
import { parseListLimit, parsePersonaId } from '../http/limits.js';

export function registerSessionReadRoutes(app: FastifyInstance, api: DaemonApi): void {
  app.get('/v1/personas/:personaId/sessions', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const query = request.query as Record<string, unknown>;
    const personaId = parsePersonaId(params['personaId']);
    const limit = parseListLimit(query['limit']);
    return reply.code(200).send({
      sessions: api.listSessions({ personaId, limit }),
    });
  });
}
