/** Persona create/start/suspend/resume/stop routes. */

import type { FastifyInstance } from 'fastify';

import { ApiError } from '../errors.js';
import type { DaemonApi } from '../daemon-api.js';
import { parsePersonaId } from '../http/limits.js';

const DISPLAY_NAME_MAX_LENGTH = 128;

/**
 * Mirrors Runtime's assertDisplayName. The Runtime still performs its own
 * check; this layer exists so malformed JSON/body shapes become a fixed 400
 * instead of an uncaught TypeError.
 */
function parseDisplayName(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError('invalid_request');
  }
  const value = (body as { readonly displayName?: unknown }).displayName;
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > DISPLAY_NAME_MAX_LENGTH ||
    value !== value.trim()
  ) {
    throw new ApiError('invalid_request');
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      throw new ApiError('invalid_request');
    }
  }
  return value;
}

export function registerPersonaWriteRoutes(app: FastifyInstance, api: DaemonApi): void {
  app.post('/v1/personas', async (request, reply) => {
    const displayName = parseDisplayName(request.body);
    const persona = await api.createPersona({ displayName });
    return reply.code(201).send({ persona });
  });

  app.post('/v1/personas/:personaId/start', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const personaId = parsePersonaId(params['personaId']);
    const persona = await api.startPersona(personaId);
    return reply.code(200).send({ persona });
  });

  app.post('/v1/personas/:personaId/suspend', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const personaId = parsePersonaId(params['personaId']);
    const persona = await api.suspendPersona(personaId);
    return reply.code(200).send({ persona });
  });

  app.post('/v1/personas/:personaId/resume', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const personaId = parsePersonaId(params['personaId']);
    const persona = await api.resumePersona(personaId);
    return reply.code(200).send({ persona });
  });

  app.post('/v1/personas/:personaId/stop', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const personaId = parsePersonaId(params['personaId']);
    const persona = await api.stopPersona(personaId);
    return reply.code(200).send({ persona });
  });
}
