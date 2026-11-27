/**
 * Test harness: real temp directories, real child processes, captured log lines.
 *
 * Nothing here fakes SQLite or the filesystem — the daemon's whole point is that
 * its resources are real, so the tests must observe real files and real PIDs.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger, type Logger, type LogFields } from '../../src/logger.js';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export const APP_ROOT = join(REPO_ROOT, 'apps', 'soul-daemon');

/**
 * Process tests spawn the **built** entry, not the TS source.
 *
 * Node's type stripping does not rewrite NodeNext `.js` specifiers to `.ts`
 * files, so `node src/main.ts` cannot resolve `./config.js`. Building first also
 * means the process tests exercise the same artifact a deployment would run.
 */
export const DAEMON_ENTRY = join(APP_ROOT, 'dist', 'main.js');

export const SIGNAL_RUNNER = join(APP_ROOT, 'test', 'fixtures', 'signal-runner.mjs');

/** Marker-controlled fixture for tests that need to connect before SIGTERM. */
export const MARKER_SIGNAL_RUNNER = join(APP_ROOT, 'test', 'fixtures', 'marker-signal-runner.mjs');

/** Required task policy. Production config has no default for these two. */
export const TEST_POLICY_ENV: Record<string, string> = {
  SOUL_TASK_MAX_ATTEMPTS: '3',
  SOUL_TASK_RETRY_BACKOFF_MS: '1000',
};

/**
 * Spawns that already name a data directory must also pass the required policy.
 * A spawn with no `SOUL_DATA_DIR` is left unchanged, so the missing-directory
 * case still fails on that variable alone.
 */
function withRequiredPolicy(env: Record<string, string>): Record<string, string> {
  if (env['SOUL_DATA_DIR'] === undefined) {
    return env;
  }
  return { ...TEST_POLICY_ENV, ...env };
}

export interface LogRecord {
  readonly [key: string]: unknown;
}

export function makeTempDir(prefix = 'sh-daemon-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** Builds workspace packages the daemon imports, then the daemon itself. */
export function buildDaemonApp(): void {
  const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

  const projects = ['contracts', 'persistence', 'runtime'] as const;
  for (const name of projects) {
    const dist = join(REPO_ROOT, 'packages', name, 'dist', 'index.js');
    if (!existsSync(dist)) {
      execFileSync(
        process.execPath,
        [tsc, '-p', join(REPO_ROOT, 'packages', name, 'tsconfig.build.json')],
        { cwd: REPO_ROOT, stdio: 'ignore' },
      );
    }
  }

  execFileSync(process.execPath, [tsc, '-p', join(APP_ROOT, 'tsconfig.build.json')], {
    cwd: APP_ROOT,
    stdio: 'ignore',
  });

  if (!existsSync(DAEMON_ENTRY)) {
    throw new Error('daemon build did not produce dist/main.js');
  }
}

/** A logger that records structured records instead of writing to stdout. */
export function createRecordingLogger(level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): {
  logger: Logger;
  records: LogRecord[];
} {
  const records: LogRecord[] = [];
  const logger = createLogger({
    level,
    sink: (line: string) => records.push(JSON.parse(line) as LogRecord),
  });
  return { logger, records };
}

export interface SpawnedDaemon {
  readonly child: ChildProcess;
  readonly records: LogRecord[];
  readonly stderr: string[];
  waitFor(predicate: (record: LogRecord) => boolean, timeoutMs?: number): Promise<LogRecord>;
  waitForExit(timeoutMs?: number): Promise<number | null>;
}

export interface SpawnOptions {
  readonly env: Record<string, string>;
  readonly entry?: string;
}

/** Spawns the real daemon process and parses its JSON log lines. */
export function spawnDaemon(options: SpawnOptions): SpawnedDaemon {
  const entry = options.entry ?? DAEMON_ENTRY;
  const child = spawn(process.execPath, [entry], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...withRequiredPolicy(options.env) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const records: LogRecord[] = [];
  const stderr: string[] = [];
  let buffer = '';

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          records.push(JSON.parse(line) as LogRecord);
        } catch {
          // Non-JSON output is not expected; keep it out of the record stream.
        }
      }
      newline = buffer.indexOf('\n');
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr.push(chunk);
  });

  const waitFor = async (
    predicate: (record: LogRecord) => boolean,
    timeoutMs = 15_000,
  ): Promise<LogRecord> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = records.find(predicate);
      if (found !== undefined) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for a log record; saw:\n${records.map((r) => JSON.stringify(r)).join('\n')}\nstderr:\n${stderr.join('')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  // `close` fires after the stdio streams are drained; waiting for `exit` alone
  // races the last log lines and makes assertions on them flaky.
  let closedCode: number | null | undefined;
  child.once('close', (code) => {
    closedCode = code;
  });

  const waitForExit = (timeoutMs = 15_000): Promise<number | null> =>
    new Promise((resolve, reject) => {
      if (closedCode !== undefined) {
        resolve(closedCode);
        return;
      }
      const timer = setTimeout(
        () =>
          reject(
            new Error(`timed out waiting for the daemon to exit; stderr:\n${stderr.join('')}`),
          ),
        timeoutMs,
      );
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

  return { child, records, stderr, waitFor, waitForExit };
}

/** Spawns a detached helper process that lives until killed. */
export function spawnSleeper(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

/** Spawns a process that exits immediately and returns its (now dead) PID. */
export async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const pid = child.pid;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (pid === undefined) {
    throw new Error('helper process did not report a pid');
  }
  return pid;
}

export type { Logger, LogFields };
