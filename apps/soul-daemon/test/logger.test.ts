import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/logger.js';

function capture(level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): {
  lines: string[];
  logger: ReturnType<typeof createLogger>;
} {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger({
      level,
      sink: (line: string) => lines.push(line),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    }),
  };
}

describe('structured logging', () => {
  it('emits one JSON object per line with the bound context', () => {
    const { lines, logger } = capture();
    logger.child({ personaId: 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC' }).info('phase_entered', {
      phase: 'RUNNING',
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      ts: '2026-01-01T00:00:00.000Z',
      level: 'info',
      event: 'phase_entered',
      personaId: 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC',
      phase: 'RUNNING',
    });
  });

  it('redacts content-bearing keys at any depth', () => {
    const { lines, logger } = capture();
    logger.info('boot_failed', {
      token: 'secret-token',
      content: 'the persona said hello',
      payload: { nested: 'memory body' },
      memory: ['a fragment'],
      phase: 'RUNNING',
      deep: { apiKey: 'k', note: 'ok' },
    });

    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    const line = lines[0] as string;
    expect(record['phase']).toBe('RUNNING');
    expect(record['token']).toBeUndefined();
    expect(record['content']).toBeUndefined();
    expect(record['payload']).toBeUndefined();
    expect(record['memory']).toBeUndefined();
    expect(record['deep']).toBeUndefined();
    expect(line).not.toContain('"token"');
    expect(line).not.toContain('"content"');
    expect(line).not.toContain('"payload"');
    expect(line).not.toContain('"memory"');
    expect(line).not.toContain('"deep"');
    expect(line).not.toContain('secret-token');
    expect(line).not.toContain('the persona said hello');
    expect(line).not.toContain('memory body');
  });

  it('redacts free-text fields that are not on the allowlist', () => {
    const { lines, logger } = capture();
    const userInput = 'user said the secret phrase amber-otter';
    const modelOutput = 'model replied with amber-otter too';
    const privateConversation = 'private conversation amber-otter';

    logger.info('boot_failed', {
      message: userInput,
      detail: modelOutput,
      context: privateConversation,
      phase: 'RUNNING',
    });

    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    const line = lines[0] as string;
    expect(record['message']).toBeUndefined();
    expect(record['detail']).toBeUndefined();
    expect(record['context']).toBeUndefined();
    expect(record['phase']).toBe('RUNNING');
    expect(line).not.toContain('"message"');
    expect(line).not.toContain('"detail"');
    expect(line).not.toContain('"context"');
    expect(line).not.toContain('amber-otter');
  });

  it('does not walk an unknown object far enough to leak a nested value', () => {
    const { lines, logger } = capture();
    logger.info('boot_failed', {
      context: { cause: { message: 'nested amber-otter', token: 'sk-live' } },
      history: ['amber-otter'],
    });

    expect(lines[0]).not.toContain('amber-otter');
    expect(lines[0]).not.toContain('sk-live');
    expect(lines[0]).not.toContain('"context"');
    expect(lines[0]).not.toContain('"history"');
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record['context']).toBeUndefined();
    expect(record['history']).toBeUndefined();
  });

  it('redacts a plain error message while keeping name and a string code', () => {
    const { lines, logger } = capture();
    const error = Object.assign(new Error('boom'), {
      name: 'DaemonError',
      code: 'lock_held',
    });

    logger.error('fatal', { error });

    const record = JSON.parse(lines[0] as string) as { error?: Record<string, unknown> };
    expect(record.error).toStrictEqual({
      name: 'DaemonError',
      code: 'lock_held',
      message: '[redacted]',
    });
    expect(lines[0]).not.toContain('boom');
  });

  it('never serializes sensitive error text', () => {
    const { lines, logger } = capture();
    const secret = 'sk-live-SECRET-TOKEN-9f3e2a7c';
    const userText = 'the persona said my password is hunter2';
    const error = new Error(`Authorization: Bearer ${secret}; ${userText}`);

    logger.error('fatal', { error });

    const line = lines[0] as string;
    expect(line).not.toContain(secret);
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('Authorization: Bearer');
    expect(JSON.parse(line)).toMatchObject({ error: { message: '[redacted]' } });
  });

  it('never writes an error stack', () => {
    const { lines, logger } = capture();
    const error = new Error('boom');
    const stackLine = error.stack?.split('\n')[1] ?? 'at ';

    logger.error('fatal', { error });

    const line = lines[0] as string;
    expect(line).not.toContain(stackLine);
    expect(line).not.toContain('.ts:');
    expect(line).not.toContain('at ');
  });

  it('does not walk an error value that is not an Error instance', () => {
    const { lines, logger } = capture();
    const error = Object.assign(new Error('nested boom'), { code: 'E_NESTED' });

    logger.error('fatal', { error: { cause: error } });

    const line = lines[0] as string;
    expect(line).not.toContain('nested boom');
    const record = JSON.parse(line) as { error?: unknown };
    expect(record.error).toBe('[redacted]');
  });

  it('does not log an external source, a raw adapter ref, or a free-text reason or event', () => {
    const { lines, logger } = capture();
    const source = 'minecraft.chat';
    const adapterId = 'minecraft';
    const ref = 'player:chat:1';
    const freeReason = 'the user typed a secret phrase amber-otter';
    const freeEvent = 'amber-otter happened';

    logger.info(freeEvent, {
      source,
      adapterId,
      adapterEventRef: ref,
      reason: freeReason,
      phase: 'RUNNING',
    });
    logger.info('phase_entered', { reason: 'probe_budget_exceeded' });

    const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
    const second = JSON.parse(lines[1] as string) as Record<string, unknown>;
    expect(first['event']).toBe('invalid_event');
    expect(first['source']).toBe('[redacted]');
    expect(first['adapterId']).toBe('[redacted]');
    expect(first['reason']).toBe('[redacted]');
    expect(first['phase']).toBe('RUNNING');
    expect(first['adapterEventRef']).toMatch(/^ref_[0-9a-f]{16}$/u);
    expect(second).toMatchObject({ event: 'phase_entered', reason: 'probe_budget_exceeded' });
    const text = lines.join('\n');
    expect(text).not.toContain(source);
    expect(text).not.toContain(adapterId);
    expect(text).not.toContain(ref);
    expect(text).not.toContain('amber-otter');

    const again = capture();
    again.logger.info('ingress.accepted', { adapterEventRef: ref });
    expect(JSON.parse(again.lines[0] as string)).toMatchObject({
      adapterEventRef: first['adapterEventRef'],
    });
  });

  it('filters by level', () => {
    const { lines, logger } = capture('warn');
    logger.debug('boot_started');
    logger.info('phase_entered');
    logger.warn('drain_started');
    logger.error('boot_failed');

    expect(lines.map((line) => (JSON.parse(line) as { event: string }).event)).toStrictEqual([
      'drain_started',
      'boot_failed',
    ]);
  });

  it('drops an event name that is not one this process emits', () => {
    const { lines, logger } = capture();
    logger.info('daemon_stopped');
    logger.info('daemon_stopped_forged');

    const events = lines.map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events).toStrictEqual(['daemon_stopped', 'invalid_event']);
    expect(lines.join('\n')).not.toContain('daemon_stopped_forged');
  });

  it('does not walk a plain object supplied as error', () => {
    const { lines, logger } = capture();
    logger.error('fatal', { error: { code: 'amber-otter', name: 'DaemonError' } });

    const record = JSON.parse(lines[0] as string) as { error?: unknown };
    expect(record.error).toBe('[redacted]');
    expect(lines[0]).not.toContain('amber-otter');
    expect(lines[0]).not.toContain('DaemonError');
  });

  it('redacts a string that does not match the rule for its key', () => {
    const { lines, logger } = capture();
    logger.info('phase_entered', {
      phase: 'not a phase amber-otter',
      code: 'lock_held',
      step: 'logging',
      personaId: 'psn_x',
    });

    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record['phase']).toBe('[redacted]');
    expect(record['code']).toBe('lock_held');
    expect(record['step']).toBe('logging');
    expect(record['personaId']).toBe('[redacted]');
    expect(lines[0]).not.toContain('amber-otter');
  });

  it('redacts an error name or code outside the closed sets', () => {
    const { lines, logger } = capture();
    const error = Object.assign(new Error('amber-otter'), {
      name: 'amber-otter happened',
      code: 'amber-otter',
    });

    logger.error('fatal', { error });

    const record = JSON.parse(lines[0] as string) as { error?: Record<string, unknown> };
    expect(record.error).toStrictEqual({
      name: '[redacted]',
      code: '[redacted]',
      message: '[redacted]',
    });
    expect(lines[0]).not.toContain('amber-otter');
  });

  it('allows API token error codes while redacting token material and paths', () => {
    const codes = ['api_token_invalid', 'api_token_insecure', 'api_token_io_failed'] as const;
    const secret = 'DO_NOT_LOG_API_TOKEN_9f3e2a7c';
    const path = '/private/should-not-leak/api.token';
    for (const code of codes) {
      const { lines, logger } = capture();
      logger.error('fatal', {
        code,
        token: secret,
        authorization: `Bearer ${secret}`,
        filePath: path,
        message: `failed at ${path}`,
      });
      const line = lines[0] as string;
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(record['code']).toBe(code);
      expect(record['token']).toBeUndefined();
      expect(record['authorization']).toBeUndefined();
      expect(record['filePath']).toBeUndefined();
      expect(record['message']).toBeUndefined();
      expect(line).not.toContain(secret);
      expect(line).not.toContain(path);
    }
  });

  it('drops an unknown field name instead of publishing it', () => {
    const phrase = 'secret-user-email-alice@example.com';
    const { lines, logger } = capture();
    logger.info('phase_entered', {
      phase: 'RUNNING',
      [phrase]: 'anything',
    });

    const line = lines[0] as string;
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(line).not.toContain(phrase);
    expect(Object.hasOwn(record, phrase)).toBe(false);
    expect(record['phase']).toBe('RUNNING');
    expect(line).toContain('"phase":"RUNNING"');
  });

  it('drops an unknown field name nested under an allowlisted object', () => {
    const phrase = 'secret-user-email-alice@example.com';
    const { lines, logger } = capture();
    logger.info('phase_entered', {
      phase: 'RUNNING',
      step: {
        status: 'ok',
        [phrase]: 'alice@example.com',
      },
    });

    const line = lines[0] as string;
    const record = JSON.parse(line) as { phase?: string; step?: Record<string, unknown> };
    expect(line).not.toContain(phrase);
    expect(line).not.toContain('alice@example.com');
    expect(record.phase).toBe('RUNNING');
    expect(record.step).toStrictEqual({ status: 'ok' });
    expect(Object.hasOwn(record.step ?? {}, phrase)).toBe(false);
  });
});
