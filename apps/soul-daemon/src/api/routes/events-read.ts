/** Read-only event routes. Event reads are always persona-scoped. */

import type { FastifyInstance } from 'fastify';

import { ApiError } from '../errors.js';
import type { DaemonApi } from '../daemon-api.js';
import { parseEnum, parseId, parsePersonaId, parseListLimit } from '../http/limits.js';
import { EVENT_STATUS_VALUES } from '../wire.js';

export function registerEventReadRoutes(app: FastifyInstance, api: DaemonApi): void {
  app.get('/v1/personas/:personaId/events', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const query = request.query as Record<string, unknown>;
    const personaId = parsePersonaId(params['personaId']);
    const status = parseEnum(query['status'], EVENT_STATUS_VALUES);
    const limit = parseListLimit(query['limit']);
    return reply.code(200).send({
      events: api.listEvents({
        personaId,
        ...(status === undefined ? {} : { status }),
        limit,
      }),
    });
  });

  app.get('/v1/personas/:personaId/events/:eventId', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const personaId = parsePersonaId(params['personaId']);
    const eventId = parseId(params['eventId']);
    const event = api.getEvent({ personaId, eventId });
    if (event === null) {
      throw new ApiError('not_found');
    }
    return reply.code(200).send({ event });
  });
}
