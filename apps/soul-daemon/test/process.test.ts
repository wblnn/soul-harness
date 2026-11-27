import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { LOCK_FILE_NAME } from '../src/lock.js';
import {
  MARKER_SIGNAL_RUNNER,
  SIGNAL_RUNNER,
  buildDaemonApp,
  makeTempDir,
  removeTempDir,
  spawnDaemon,
  type LogRecord,
  type SpawnedDaemon,
} from './helpers/harness.js';
import {
  prepareDatabase,
  readTask,
  seedPersona,
  seedEvent,
  seedQueuedTask,
  seedRunningTask,
  readEvent,
} from './helpers/recovery-seed.js';

const dirs: string[] = [];
const daemons: SpawnedDaemon[] = [];
const wsClients: WebSocket[] = [];

afterEach(async () => {
  while (wsClients.length > 0) {
    const socket = wsClients.pop() as WebSocket;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }
  while (daemons.length > 0) {
    const daemon = daemons.pop() as SpawnedDaemon;
    const child: ChildProcess = daemon.child;
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    await daemon.waitForExit(5000).catch(() => undefined);
  }
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
});

function tempDir(): string {
  const dir = makeTempDir('sh-proc-');
  dirs.push(dir);
  return dir;
}

function isPhase(record: LogRecord, phase: string): boolean {
  return record['event'] === 'phase_entered' && record['phase'] === phase;
}

/** Opens the real file and checks the migration table is still readable. */
function assertDatabaseIntact(dir: string): void {
  const db = new DatabaseSync(join(dir, 'soul.db'));
  try {
    const row = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get() as
      { version: number } | undefined;
    expect(row?.version).toBe(1);
  } finally {
    db.close();
  }
}

function openedDatabase(spawned: SpawnedDaemon): boolean {
  return spawned.records.some(
    (record) => record['event'] === 'step_ok' && record['step'] === 'sqlite_open',
  );
}

interface HttpResult {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function httpRequest(options: {
  readonly method?: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | Buffer;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: 18700,
        method: options.method ?? 'GET',
        path: options.path,
        headers: {
          Host: '127.0.0.1:18700',
          ...options.headers,
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body,
          });
        });
      },
    );
    req.once('error', reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

function readApiToken(dir: string): string {
  const token = readFileSync(join(dir, 'api.token'), 'utf8').replace(/\r?\n$/u, '');
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  return token;
}

function eventCount(dir: string): number {
  const db = new DatabaseSync(join(dir, 'soul.db'));
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM events').get() as
      { count: number } | undefined;
    return row?.count ?? 0;
  } finally {
    db.close();
  }
}

interface MessageQueue {
  next(timeoutMs?: number): Promise<unknown>;
}

function collectWebSocket(socket: WebSocket): MessageQueue {
  const messages: unknown[] = [];
  const waiters: Array<{
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as unknown;
    const waiter = waiters.shift();
    if (waiter === undefined) {
      messages.push(message);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });
  return {
    next(timeoutMs = 3000): Promise<unknown> {
      if (messages.length > 0) {
        return Promise.resolve(messages.shift());
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            reject(new Error('websocket message timeout'));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

function openWebSocket(): Promise<WebSocket> {
  const socket = new WebSocket('ws://127.0.0.1:18700/v1/ws', ['soul.ws.v1']);
  wsClients.push(socket);
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error('websocket open failed')), {
      once: true,
    });
  });
}

function waitForWebSocketClose(
  socket: WebSocket,
  timeoutMs = 5000,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket close timeout')), timeoutMs);
    socket.addEventListener(
      'close',
      (event) => {
        clearTimeout(timer);
        resolve({ code: event.code, reason: event.reason });
      },
      { once: true },
    );
  });
}
/**
 * Remembers `close` so a race can see the loser exit without waiting for a
 * `RUNNING` log that will never arrive. The listener is attached before the
 * first await, so the event cannot be missed.
 */
function watchClose(spawned: SpawnedDaemon): { code(): number | null | undefined } {
  let code: number | null | undefined;
  spawned.child.once('close', (value) => {
    code = value;
  });
  return {
    code: () => code,
  };
}

async function waitForOneRunning(
  first: SpawnedDaemon,
  second: SpawnedDaemon,
  timeoutMs: number,
): Promise<{ winner: SpawnedDaemon; loser: SpawnedDaemon; loserCode: number | null }> {
  const firstClose = watchClose(first);
  const secondClose = watchClose(second);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const pairs = [
      { winner: first, loser: second, loserCode: secondClose.code() },
      { winner: second, loser: first, loserCode: firstClose.code() },
    ];
    for (const pair of pairs) {
      if (
        pair.winner.records.some((record) => isPhase(record, 'RUNNING')) &&
        pair.loserCode !== undefined
      ) {
        return { winner: pair.winner, loser: pair.loser, loserCode: pair.loserCode };
      }
    }
    if (
      first.records.some((record) => isPhase(record, 'RUNNING')) &&
      second.records.some((record) => isPhase(record, 'RUNNING'))
    ) {
      throw new Error('both processes reached RUNNING');
    }
    if (firstClose.code() !== undefined && secondClose.code() !== undefined) {
      throw new Error(`both processes exited\n${first.stderr.join('')}\n${second.stderr.join('')}`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for one RUNNING process and one exit\n${first.stderr.join('')}\n${second.stderr.join('')}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const TEST_TIMEOUT = 60_000;

beforeAll(() => {
  buildDaemonApp();
}, TEST_TIMEOUT);

// Exit code 6 stays an in-process assertion (store.close failure). These
// process tests do not forge that failure.
describe('real process lifecycle', { timeout: TEST_TIMEOUT }, () => {
  it(
    'rejects a missing data directory with exit code 2',
    async () => {
      const spawned = spawnDaemon({ env: {} });
      daemons.push(spawned);

      const code = await spawned.waitForExit();
      expect(code).toBe(2);
      expect(spawned.records.some((record) => record['event'] === 'fatal')).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'rejects a data directory that is a regular file with exit code 3',
    async () => {
      const dir = tempDir();
      const path = join(dir, 'nope');
      writeFileSync(path, 'x');

      const spawned = spawnDaemon({ env: { SOUL_DATA_DIR: path } });
      daemons.push(spawned);

      const code = await spawned.waitForExit();
      expect(code).toBe(3);
    },
    TEST_TIMEOUT,
  );

  it(
    'stops cleanly on SIGTERM: scheduler stops before the process, database stays openable',
    async () => {
      const dir = tempDir();
      prepareDatabase(dir, (store) => {
        seedPersona(store, 1);
        seedQueuedTask(store, 1);
      });
      const before = readTask(dir, 1);

      const spawned = spawnDaemon({ env: { SOUL_DATA_DIR: dir }, entry: SIGNAL_RUNNER });
      daemons.push(spawned);

      await spawned.waitFor((record) => isPhase(record, 'RUNNING'));

      const code = await spawned.waitForExit();
      expect(code).toBe(0);
      expect(spawned.records.some((record) => record['event'] === 'signal_received')).toBe(true);
      expect(spawned.records.some((record) => record['event'] === 'scheduler_started')).toBe(true);

      const stoppedAt = spawned.records.findIndex(
        (record) => record['event'] === 'scheduler_stopped',
      );
      const daemonStoppedAt = spawned.records.findIndex(
        (record) => record['event'] === 'daemon_stopped',
      );
      expect(stoppedAt).toBeGreaterThanOrEqual(0);
      expect(daemonStoppedAt).toBeGreaterThan(stoppedAt);

      expect(existsSync(join(dir, 'soul.db'))).toBe(true);
      expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
      assertDatabaseIntact(dir);
      expect(readTask(dir, 1)).toMatchObject({
        state: 'queued',
        attempt: 0,
        runId: before?.runId ?? null,
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'aborts startup on SIGTERM and releases the lock without reaching RUNNING',
    async () => {
      const dir = tempDir();

      const spawned = spawnDaemon({
        env: { SOUL_DATA_DIR: dir, SOUL_TEST_SIGNAL_AT: 'MIGRATING' },
        entry: SIGNAL_RUNNER,
      });
      daemons.push(spawned);

      await spawned.waitFor((record) => isPhase(record, 'MIGRATING'));
      const code = await spawned.waitForExit();

      expect(code).toBe(0);
      expect(spawned.records.some((record) => record['event'] === 'signal_received')).toBe(true);
      expect(spawned.records.some((record) => record['event'] === 'boot_aborted')).toBe(true);
      expect(spawned.records.some((record) => isPhase(record, 'RUNNING'))).toBe(false);
      expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'holds the lock while RUNNING',
    async () => {
      const dir = tempDir();

      const spawned = spawnDaemon({ env: { SOUL_DATA_DIR: dir } });
      daemons.push(spawned);
      await spawned.waitFor((record) => isPhase(record, 'RUNNING'));

      const lockPath = join(dir, LOCK_FILE_NAME);
      expect(existsSync(lockPath)).toBe(true);
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
      expect(lock['pid']).toBe(spawned.child.pid);
    },
    TEST_TIMEOUT,
  );

  it(
    'refuses a second instance on the same data directory and touches no database',
    async () => {
      const dir = tempDir();

      const first = spawnDaemon({ env: { SOUL_DATA_DIR: dir } });
      daemons.push(first);
      await first.waitFor((record) => isPhase(record, 'RUNNING'));

      // A second, empty directory keeps the "no database was opened" assertion honest.
      const secondDir = tempDir();
      writeFileSync(
        join(secondDir, LOCK_FILE_NAME),
        JSON.stringify({
          pid: first.child.pid,
          bootToken: 'other',
          startedAt: 'now',
          dataDir: secondDir,
        }),
      );

      const second = spawnDaemon({ env: { SOUL_DATA_DIR: secondDir } });
      daemons.push(second);

      const code = await second.waitForExit();
      expect(code).toBe(4);
      expect(existsSync(join(secondDir, 'soul.db'))).toBe(false);

      expect(first.child.exitCode).toBeNull();
    },
    TEST_TIMEOUT,
  );

  it(
    'only one of two real processes racing the same directory reaches RUNNING',
    async () => {
      const dir = tempDir();

      const first = spawnDaemon({ env: { SOUL_DATA_DIR: dir } });
      const second = spawnDaemon({ env: { SOUL_DATA_DIR: dir } });
      daemons.push(first, second);

      const { winner, loser, loserCode } = await waitForOneRunning(first, second, 15_000);

      expect(loserCode).toBe(4);
      expect(loser.records.some((record) => isPhase(record, 'RUNNING'))).toBe(false);
      expect(openedDatabase(loser)).toBe(false);
      expect(openedDatabase(winner)).toBe(true);
      expect(winner.child.exitCode).toBeNull();
      expect(existsSync(join(dir, 'soul.db'))).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'does not start a second daemon when the fixed API port is already held',
    async () => {
      const firstDir = tempDir();
      const secondDir = tempDir();
      const first = spawnDaemon({ env: { SOUL_DATA_DIR: firstDir } });
      daemons.push(first);
      await first.waitFor((record) => isPhase(record, 'RUNNING'));

      const second = spawnDaemon({ env: { SOUL_DATA_DIR: secondDir } });
      daemons.push(second);

      const code = await second.waitForExit();
      expect(code).toBe(5);
      expect(second.records.some((record) => record['code'] === 'http_api_start_failed')).toBe(
        true,
      );
      expect(second.records.some((record) => isPhase(record, 'RUNNING'))).toBe(false);
      expect(existsSync(join(secondDir, LOCK_FILE_NAME))).toBe(false);
      expect(first.child.exitCode).toBeNull();
    },
    TEST_TIMEOUT,
  );

  it(
    'fails with exit code 5 when migrations fail, and releases the lock',
    async () => {
      const dir = tempDir();

      const seed = spawnDaemon({ env: { SOUL_DATA_DIR: dir }, entry: SIGNAL_RUNNER });
      daemons.push(seed);
      await seed.waitFor((record) => isPhase(record, 'RUNNING'));
      await seed.waitForExit();

      const db = new DatabaseSync(join(dir, 'soul.db'));
      db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('deadbeef');
      db.close();

      const failing = spawnDaemon({ env: { SOUL_DATA_DIR: dir } });
      daemons.push(failing);

      const code = await failing.waitForExit();
      expect(code).toBe(5);
      expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'serves real HTTP and WebSocket, then drains on the marker SIGTERM',
    async () => {
      const dir = tempDir();
      const marker = join(dir, 'ready.marker');
      const spawned = spawnDaemon({
        env: {
          SOUL_DATA_DIR: dir,
          SOUL_TEST_SIGNAL_MARKER: marker,
        },
        entry: MARKER_SIGNAL_RUNNER,
      });
      daemons.push(spawned);
      await spawned.waitFor((record) => isPhase(record, 'RUNNING'));

      const token = readApiToken(dir);
      const auth = { Authorization: `Bearer ${token}` };
      expect(statSync(join(dir, 'api.token')).size).toBe(44);
      if (process.platform !== 'win32') {
        expect(statSync(join(dir, 'api.token')).mode & 0o7777).toBe(0o600);
      }

      const live = await httpRequest({ path: '/v1/health/live' });
      const ready = await httpRequest({ path: '/v1/health/ready' });
      expect(live.statusCode).toBe(200);
      expect(JSON.parse(live.body)).toStrictEqual({ status: 'ok' });
      expect(ready.statusCode).toBe(200);
      expect(JSON.parse(ready.body)).toStrictEqual({ status: 'ready' });

      const noAuth = await httpRequest({ path: '/v1/status' });
      const wrongAuth = await httpRequest({
        path: '/v1/status',
        headers: { Authorization: 'Bearer wrong' },
      });
      const status = await httpRequest({ path: '/v1/status', headers: auth });
      expect(noAuth.statusCode).toBe(401);
      expect(wrongAuth.statusCode).toBe(401);
      expect(status.statusCode).toBe(200);
      expect(status.body).not.toContain(token);
      expect(status.body).not.toContain('dataDir');
      expect(status.body).not.toContain('databaseFile');
      expect(status.body).not.toContain('lockPath');

      const badHost = await httpRequest({
        path: '/v1/status',
        headers: { ...auth, Host: 'evil.example' },
      });
      const badOrigin = await httpRequest({
        path: '/v1/status',
        headers: { ...auth, Origin: 'https://evil.example' },
      });
      const allowedOrigin = 'http://127.0.0.1:18701';
      const cors = await httpRequest({
        path: '/v1/status',
        headers: { ...auth, Origin: allowedOrigin },
      });
      expect(badHost.statusCode).toBe(403);
      expect(badOrigin.statusCode).toBe(403);
      expect(cors.statusCode).toBe(200);
      expect(cors.headers['access-control-allow-origin']).toBe(allowedOrigin);
      expect(cors.headers['access-control-allow-origin']).not.toBe('*');
      expect(cors.headers['access-control-allow-credentials']).toBeUndefined();
      expect(cors.headers['set-cookie']).toBeUndefined();

      const displayName = 'E5A_SECRET_DISPLAY_NAME';
      const created = await httpRequest({
        method: 'POST',
        path: '/v1/personas',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName }),
      });
      expect(created.statusCode).toBe(201);
      const createdBody = JSON.parse(created.body) as { persona: { id: string } };
      const personaId = createdBody.persona.id;
      const listed = await httpRequest({ path: '/v1/personas', headers: auth });
      const one = await httpRequest({ path: `/v1/personas/${personaId}`, headers: auth });
      expect(listed.statusCode).toBe(200);
      expect(JSON.parse(listed.body)).toMatchObject({
        personas: [expect.objectContaining({ id: personaId })],
      });
      expect(one.statusCode).toBe(200);
      expect(JSON.parse(one.body)).toStrictEqual({ persona: createdBody.persona });

      const oversizedBody = JSON.stringify({ displayName: 'x'.repeat(70_000) });
      const oversized = await httpRequest({
        method: 'POST',
        path: '/v1/personas',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: oversizedBody,
      });
      expect(oversized.statusCode).toBe(413);
      expect(JSON.parse(oversized.body)).toStrictEqual({
        error: { code: 'too_large', message: 'request body too large' },
      });
      expect(oversized.body).not.toContain('dataDir');

      const unauth = await openWebSocket();
      let unauthMessages = 0;
      unauth.addEventListener('message', () => {
        unauthMessages += 1;
      });
      const unauthClose = waitForWebSocketClose(unauth);
      unauth.send(JSON.stringify({ type: 'pull' }));
      expect(await unauthClose).toMatchObject({ code: 1008, reason: 'unauthorized' });
      expect(unauthMessages).toBe(0);

      const socket = await openWebSocket();
      const messages = collectWebSocket(socket);
      socket.send(JSON.stringify({ type: 'auth', token }));
      expect(await messages.next()).toMatchObject({
        type: 'hello',
        protocol: 'soul.ws.v1',
      });
      expect(await messages.next()).toMatchObject({ type: 'snapshot' });
      socket.send(JSON.stringify({ type: 'pull' }));
      expect(await messages.next()).toMatchObject({ type: 'snapshot' });

      const closePromise = waitForWebSocketClose(socket);
      const shuttingDown = messages.next();
      writeFileSync(marker, 'ready');
      expect(await shuttingDown).toStrictEqual({
        type: 'shutting_down',
        reason: 'daemon_stop',
      });
      expect(await closePromise).toStrictEqual({ code: 1001, reason: 'daemon_stop' });

      const code = await spawned.waitForExit();
      expect(code).toBe(0);
      expect(spawned.records.some((record) => record['event'] === 'signal_received')).toBe(true);
      const stoppedAt = spawned.records.findIndex(
        (record) => record['event'] === 'scheduler_stopped',
      );
      const daemonStoppedAt = spawned.records.findIndex(
        (record) => record['event'] === 'daemon_stopped',
      );
      expect(stoppedAt).toBeGreaterThanOrEqual(0);
      expect(daemonStoppedAt).toBeGreaterThan(stoppedAt);
      expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
      expect(existsSync(join(dir, 'soul.db'))).toBe(true);
      assertDatabaseIntact(dir);
      await expect(httpRequest({ path: '/v1/health/live' })).rejects.toBeTruthy();

      const logs = JSON.stringify(spawned.records) + spawned.stderr.join('');
      expect(logs).not.toContain(token);
      expect(logs).not.toContain('Authorization');
      expect(logs).not.toContain('Bearer');
      expect(logs).not.toContain(displayName);
    },
    TEST_TIMEOUT,
  );

  it(
    'fails real startup with an invalid token and preserves the file',
    async () => {
      const dir = tempDir();
      const invalidToken = 'E5A_INVALID_TOKEN_DO_NOT_LOG';
      const path = join(dir, 'api.token');
      writeFileSync(path, `${invalidToken}\n`, { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') {
        chmodSync(path, 0o600);
      }

      const spawned = spawnDaemon({ env: { SOUL_DATA_DIR: dir } });
      daemons.push(spawned);
      const code = await spawned.waitForExit();
      expect(code).toBe(5);
      expect(spawned.records.some((record) => record['code'] === 'api_token_invalid')).toBe(true);
      expect(
        spawned.records.some(
          (record) => record['event'] === 'step_ok' && record['step'] === 'sqlite_open',
        ),
      ).toBe(false);
      expect(spawned.records.some((record) => isPhase(record, 'RUNNING'))).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(`${invalidToken}\n`);
      expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
      const logs = JSON.stringify(spawned.records) + spawned.stderr.join('');
      expect(logs).not.toContain(invalidToken);
    },
    TEST_TIMEOUT,
  );

  it(
    'survives SIGKILL: the database stays intact and the next start keeps the task row',
    async () => {
      const dir = tempDir();
      prepareDatabase(dir, (store) => {
        seedPersona(store, 1);
        seedQueuedTask(store, 1);
        seedEvent(store, 1, 1, 'received');
      });
      const before = readTask(dir, 1);
      const eventsBefore = eventCount(dir);

      const crashed = spawnDaemon({ env: { SOUL_DATA_DIR: dir } });
      daemons.push(crashed);
      await crashed.waitFor((record) => isPhase(record, 'RUNNING'));

      const token = readApiToken(dir);
      assertDatabaseIntact(dir);
      expect(eventCount(dir)).toBe(eventsBefore);

      crashed.child.kill('SIGKILL');
      const crashCode = await crashed.waitForExit();
      expect(crashCode).not.toBe(0);
      expect(crashed.records.some((record) => record['event'] === 'daemon_stopped')).toBe(false);
      expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(true);
      assertDatabaseIntact(dir);
      expect(readTask(dir, 1)).toMatchObject({
        state: 'queued',
        attempt: 0,
        runId: before?.runId ?? null,
      });

      const restarted = spawnDaemon({ env: { SOUL_DATA_DIR: dir } });
      daemons.push(restarted);
      await restarted.waitFor((record) => isPhase(record, 'RUNNING'));

      const lock = JSON.parse(readFileSync(join(dir, LOCK_FILE_NAME), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(lock['pid']).toBe(restarted.child.pid);
      expect(restarted.records.some((record) => record['event'] === 'daemon_running')).toBe(true);
      expect(readApiToken(dir)).toBe(token);
      const status = await httpRequest({
        path: '/v1/status',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(status.statusCode).toBe(200);
      expect(eventCount(dir)).toBe(eventsBefore);
      expect(readEvent(dir, 1)).not.toBeNull();
      expect(readTask(dir, 1)).toMatchObject({
        state: 'queued',
        attempt: 0,
        runId: before?.runId ?? null,
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'does not delete a lock it cannot prove stale (live foreign pid)',
    async () => {
      const dir = tempDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, LOCK_FILE_NAME),
        JSON.stringify({ pid: process.pid, bootToken: 'live', startedAt: 'now', dataDir: dir }),
      );

      const spawned = spawnDaemon({ env: { SOUL_DATA_DIR: dir } });
      daemons.push(spawned);

      const code = await spawned.waitForExit();
      expect(code).toBe(4);
      expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(true);
      expect(existsSync(join(dir, 'soul.db'))).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'finishes recovery, starts the empty scheduler, and still does not dispatch',
    async () => {
      const dir = tempDir();
      const spawned = spawnDaemon({ env: { SOUL_DATA_DIR: dir }, entry: SIGNAL_RUNNER });
      daemons.push(spawned);

      await spawned.waitFor((record) => isPhase(record, 'RUNNING'));
      const code = await spawned.waitForExit();

      expect(code).toBe(0);
      expect(
        spawned.records.some(
          (record) => record['event'] === 'step_ok' && record['step'] === 'runtime_recovery',
        ),
      ).toBe(true);
      expect(
        spawned.records.some(
          (record) => record['event'] === 'scheduler_started' && record['handlers'] === 0,
        ),
      ).toBe(true);
      expect(spawned.records.some((record) => record['event'] === 'scheduler_created')).toBe(true);
      expect(
        spawned.records.some(
          (record) =>
            record['event'] === 'daemon_running' &&
            record['taskDispatch'] === 'unavailable_no_handlers' &&
            record['eventIngress'] === 'unavailable_no_transport',
        ),
      ).toBe(true);
      expect(spawned.records.some((record) => record['event'] === 'scheduler_stopped')).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'fails closed on a partial recovery and the next start converges only the remaining task',
    async () => {
      const dir = tempDir();
      prepareDatabase(dir, (store) => {
        seedPersona(store, 1);
        seedRunningTask(store, 1);
        seedRunningTask(store, 2);
      });
      const smaller = readTask(dir, 1);
      const larger = readTask(dir, 2);

      const first = spawnDaemon({
        env: { SOUL_DATA_DIR: dir, SOUL_RECOVERY_MAX_ROWS: '2' },
      });
      daemons.push(first);
      const firstCode = await first.waitForExit();
      expect(firstCode).toBe(5);
      const incomplete = first.records.find((record) => record['event'] === 'recovery_incomplete');
      expect(incomplete?.['reason']).toBe('row_budget_exceeded');
      expect(incomplete?.['tasksRequeued']).toBe(1);
      expect(first.records.some((record) => record['event'] === 'scheduler_started')).toBe(false);
      expect(first.records.some((record) => record['event'] === 'daemon_running')).toBe(false);
      expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
      expect(existsSync(join(dir, 'soul.db'))).toBe(true);
      assertDatabaseIntact(dir);
      expect(readTask(dir, 1)).toMatchObject({
        state: 'queued',
        attempt: 1,
        runId: smaller?.runId,
      });
      expect(readTask(dir, 2)).toMatchObject({
        state: 'running',
        attempt: 1,
        runId: larger?.runId,
      });

      const second = spawnDaemon({
        env: { SOUL_DATA_DIR: dir, SOUL_RECOVERY_MAX_ROWS: '10000' },
        entry: SIGNAL_RUNNER,
      });
      daemons.push(second);
      await second.waitFor((record) => isPhase(record, 'RUNNING'));
      const secondCode = await second.waitForExit();
      expect(secondCode).toBe(0);
      const step = second.records.find(
        (record) => record['event'] === 'step_ok' && record['step'] === 'runtime_recovery',
      );
      expect(step?.['tasksRequeued']).toBe(1);
      expect(readTask(dir, 1)).toMatchObject({
        state: 'queued',
        attempt: 1,
        runId: smaller?.runId,
      });
      expect(readTask(dir, 2)).toMatchObject({ state: 'queued', attempt: 1, runId: larger?.runId });
    },
    TEST_TIMEOUT,
  );

  it(
    'rejects a missing task policy before opening the database',
    async () => {
      const dir = tempDir();
      const spawned = spawnDaemon({
        env: { SOUL_DATA_DIR: dir, SOUL_TASK_MAX_ATTEMPTS: '' },
      });
      daemons.push(spawned);

      const code = await spawned.waitForExit();
      expect(code).toBe(2);
      expect(existsSync(join(dir, 'soul.db'))).toBe(false);
    },
    TEST_TIMEOUT,
  );
});
