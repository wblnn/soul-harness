/** Read-only Persona routes. No write action is registered in E2. */

import type { FastifyInstance } from 'fastify';

import { PERSONA_STATES } from '@soul-harness/persistence';

import { ApiError } from '../errors.js';
import type { DaemonApi } from '../daemon-api.js';
import { parseEnum, parseListLimit, parsePersonaId } from '../http/limits.js';

export function registerPersonaReadRoutes(app: FastifyInstance, api: DaemonApi): void {
  app.get('/v1/personas', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const state = parseEnum(query['state'], PERSONA_STATES);
    const limit = parseListLimit(query['limit']);
    return reply.code(200).send({
      personas: api.listPersonas({ ...(state === undefined ? {} : { state }), limit }),
    });
  });

  app.get('/v1/personas/:personaId', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const personaId = parsePersonaId(params['personaId']);
    const persona = api.getPersona(personaId);
    if (persona === null) {
      throw new ApiError('not_found');
    }
    return reply.code(200).send({ persona });
  });
}
