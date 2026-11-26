import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, type DaemonConfig } from '../src/config.js';
import { SoulDaemon } from '../src/daemon.js';
import { DaemonError } from '../src/errors.js';
import { LOCK_FILE_NAME } from '../src/lock.js';
import { exitCodeFor, run } from '../src/main.js';
import type { LocalApiServer, LocalApiServerOptions } from '../src/api/server.js';
import {
  createRecordingLogger,
  makeTempDir,
  removeTempDir,
  TEST_POLICY_ENV,
} from './helpers/harness.js';

import type {
  SchedulerOptions,
  StimulusIngress,
  StimulusIngressOptions,
  TaskScheduler,
} from '@soul-harness/runtime';

interface RuntimeModule {
  createStimulusIngress(options: StimulusIngressOptions): StimulusIngress;
  createScheduler(options: SchedulerOptions): TaskScheduler;
}

interface SeenIngress {
  readonly store: object;
  readonly config: object;
  readonly now: () => number;
}

interface SeenScheduler {
  readonly store: object;
  readonly policy: object;
  readonly config: object | undefined;
  readonly handlers: unknown;
  readonly now: () => number;
}

const control = vi.hoisted(() => {
  return {
    mode: 'passthrough' as
      | 'passthrough'
      | 'ingress'
      | 'ingress-close-fail'
      | 'scheduler-create'
      | 'scheduler-start'
      | 'stop-hang'
      | 'stop-reject'
      | 'store-close-fail',
    apiMode: 'passthrough' as
      'passthrough' | 'listen-fail' | 'listen-close-fail' | 'close-fail' | 'drain-fail',
    ingress: [] as SeenIngress[],
    schedulers: [] as SeenScheduler[],
    ingressCloses: 0,
    stopCalls: 0,
    releaseStop: null as (() => void) | null,
  };
});

vi.mock('@soul-harness/runtime', async (importOriginal) => {
  const actual = (await importOriginal()) as RuntimeModule & Record<string, unknown>;
  return {
    ...actual,
    createStimulusIngress(
      options: Parameters<typeof actual.createStimulusIngress>[0],
    ): ReturnType<typeof actual.createStimulusIngress> {
      if (control.mode === 'ingress') {
        throw new Error('ingress refused');
      }
      control.ingress.push({
        store: options.store,
        config: options.config,
        now: options.now ?? Date.now,
      });
      const ingress = actual.createStimulusIngress(options);
      return new Proxy(ingress, {
        get(target, prop, receiver) {
          if (prop === 'close') {
            return () => {
              control.ingressCloses += 1;
              target.close();
              if (control.mode === 'ingress-close-fail') {
                throw new Error('ingress close failed');
              }
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
    createScheduler(
      options: Parameters<typeof actual.createScheduler>[0],
    ): ReturnType<typeof actual.createScheduler> {
      control.schedulers.push({
        store: options.store,
        policy: options.policy,
        config: options.config,
        handlers: options.handlers,
        now: options.now ?? Date.now,
      });
      if (control.mode === 'store-close-fail') {
        const store = options.store as { close(): void };
        const close = store.close.bind(store);
        store.close = () => {
          close();
          throw new Error('store close failed');
        };
      }
      if (control.mode === 'scheduler-create') {
        throw new Error('scheduler refused');
      }
      if (control.mode === 'stop-hang') {
        let resolveStop: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          resolveStop = resolve;
        });
        control.releaseStop = resolveStop;
        const hanging = {
          get state() {
            return 'running' as const;
          },
          start() {
            return undefined;
          },
          stop() {
            control.stopCalls += 1;
            return gate;
          },
          wake() {
            return undefined;
          },
          tick: () => Promise.resolve({ personasVisited: 0, claimed: 0, dispatched: 0 }),
          enqueueTask: () => Promise.reject(new Error('no handler')),
          pauseTask: () => Promise.reject(new Error('no handler')),
          resumeTask: () => Promise.reject(new Error('no handler')),
          cancelTask: () => Promise.reject(new Error('no handler')),
          stats: () => ({ state: 'running' as const, activeHandlers: 0, activeUnits: 0 }),
        };
        return hanging;
      }
      if (control.mode === 'stop-reject') {
        return {
          get state() {
            return 'running' as const;
          },
          start() {
            return undefined;
          },
          stop() {
            control.stopCalls += 1;
            return Promise.reject(new Error('stop failed'));
          },
          wake() {
            return undefined;
          },
          tick: () => Promise.resolve({ personasVisited: 0, claimed: 0, dispatched: 0 }),
          enqueueTask: () => Promise.reject(new Error('no handler')),
          pauseTask: () => Promise.reject(new Error('no handler')),
          resumeTask: () => Promise.reject(new Error('no handler')),
          cancelTask: () => Promise.reject(new Error('no handler')),
          stats: () => ({ state: 'running' as const, activeHandlers: 0, activeUnits: 0 }),
        };
      }
      const scheduler = actual.createScheduler(options);
      if (control.mode === 'scheduler-start') {
        return new Proxy(scheduler, {
          get(target, prop, receiver) {
            if (prop === 'start') {
              return () => {
                throw new Error('start refused');
              };
            }
            if (prop === 'stop') {
              return () => {
                control.stopCalls += 1;
                return target.stop();
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
      }
      return scheduler;
    },
  };
});

vi.mock('../src/api/server.js', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    createLocalApiServer(options: LocalApiServerOptions): LocalApiServer;
  };
  return {
    ...actual,
    createLocalApiServer(options: LocalApiServerOptions): LocalApiServer {
      if (control.apiMode === 'passthrough') {
        return actual.createLocalApiServer(options);
      }
      let state: 'assembled' | 'running' | 'draining' | 'stopped' | 'failed' = 'assembled';
      return {
        get state() {
          return state;
        },
        get listening() {
          return state === 'running' || state === 'draining';
        },
        app: {} as never,
        async listen(): Promise<void> {
          if (control.apiMode === 'listen-fail' || control.apiMode === 'listen-close-fail') {
            state = 'failed';
            throw new DaemonError('http_api_start_failed', 'fake listen failure');
          }
          state = 'running';
        },
        async beginDrain(): Promise<void> {
          if (control.apiMode === 'drain-fail') {
            state = 'failed';
            throw new DaemonError('shutdown_failed', 'fake drain failure');
          }
          state = 'draining';
        },
        async close(): Promise<void> {
          if (control.apiMode === 'close-fail' || control.apiMode === 'listen-close-fail') {
            state = 'failed';
            throw new DaemonError('shutdown_failed', 'fake close failure');
          }
          state = 'stopped';
        },
      };
    },
  };
});

const dirs: string[] = [];

beforeEach(() => {
  control.mode = 'passthrough';
  control.apiMode = 'passthrough';
  control.ingress.length = 0;
  control.schedulers.length = 0;
  control.ingressCloses = 0;
  control.stopCalls = 0;
  control.releaseStop = null;
});

afterEach(() => {
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
});

function tempDir(): string {
  const dir = makeTempDir('sh-ready-fail-');
  dirs.push(dir);
  return dir;
}

function makeDaemon(dir: string): { daemon: SoulDaemon; config: DaemonConfig } {
  const config = loadConfig({ SOUL_DATA_DIR: dir, ...TEST_POLICY_ENV }, process.cwd());
  const { logger } = createRecordingLogger();
  return { daemon: new SoulDaemon({ config, logger }), config };
}

/** Test-only cleanup after a deliberately retained Store/Lock failure. */
function forceCleanup(dir: string): void {
  const store = control.schedulers[0]?.store as { close(): void } | undefined;
  store?.close();
  rmSync(join(dir, LOCK_FILE_NAME), { force: true });
}

describe('READY failure paths', () => {
  it('passes one store, one policy, and the frozen ingress config', async () => {
    const dir = tempDir();
    const { daemon, config } = makeDaemon(dir);
    await daemon.start();

    expect(control.ingress).toHaveLength(1);
    expect(control.schedulers).toHaveLength(1);
    const ingress = control.ingress[0];
    const scheduler = control.schedulers[0];
    if (ingress === undefined || scheduler === undefined) {
      throw new Error('assembly was not observed');
    }
    expect(ingress.store).toBe(scheduler.store);
    expect(ingress.config).toBe(config.ingress);
    expect(scheduler.policy).toBe(config.policy);
    expect(scheduler.config).toBe(config.scheduler);
    expect(ingress.now).toBe(scheduler.now);
    expect(scheduler.handlers).toBeInstanceOf(Map);
    expect((scheduler.handlers as Map<string, unknown>).size).toBe(0);

    await daemon.stop('done');
  });

  it('maps ingress construction failure and does not create a scheduler', async () => {
    control.mode = 'ingress';
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);

    const caught = await daemon.start().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonError);
    expect(caught).toMatchObject({
      code: 'event_bus_start_failed',
      message: 'event bus failed to start',
    });
    expect((caught as DaemonError).details).toBeUndefined();
    expect((caught as Error).cause).toBeInstanceOf(Error);
    expect(((caught as Error).cause as Error).message).toBe('ingress refused');
    expect(control.schedulers).toHaveLength(0);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
    expect(daemon.phase).toBe('FAILED');
  });

  it('maps scheduler construction failure and still closes the ingress', async () => {
    control.mode = 'scheduler-create';
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);

    const caught = await daemon.start().catch((error: unknown) => error);

    expect(caught).toMatchObject({
      code: 'scheduler_start_failed',
      message: 'scheduler failed to start',
    });
    expect((caught as DaemonError).details).toBeUndefined();
    expect(control.ingressCloses).toBe(1);
    expect(control.schedulers).toHaveLength(1);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
  });

  it('stops a created scheduler when start() throws', async () => {
    control.mode = 'scheduler-start';
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);

    const caught = await daemon.start().catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: 'scheduler_start_failed' });
    expect(control.stopCalls).toBe(1);
    expect(control.ingressCloses).toBe(1);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);

    control.mode = 'passthrough';
    const second = makeDaemon(dir);
    const report = await second.daemon.start();
    expect(report.phase).toBe('RUNNING');
    await second.daemon.stop('done');
  });

  it('does not close the store until the scheduler stop promise resolves', async () => {
    control.mode = 'stop-hang';
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);
    await daemon.start();

    const stopPromise = daemon.stop('hang');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(control.ingressCloses).toBe(1);
    expect(control.stopCalls).toBe(1);
    expect(daemon.status.storeOpen).toBe(true);
    expect(daemon.status.lockHeld).toBe(true);
    expect(daemon.phase).toBe('DRAINING');

    for (let attempt = 0; attempt < 200 && control.releaseStop === null; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const release = control.releaseStop;
    if (release === null) {
      throw new Error('stop gate was not installed');
    }
    release();
    const report = await stopPromise;
    expect(report.phase).toBe('STOPPED');
    expect(report.steps.every((step) => step.status === 'ok')).toBe(true);
    expect(daemon.status.storeOpen).toBe(false);
    expect(daemon.status.lockHeld).toBe(false);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
  });

  it('keeps the lock and exits as shutdown_failed when store.close throws', async () => {
    control.mode = 'store-close-fail';
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);
    await daemon.start();

    const first = daemon.stop('close-failed');
    const second = daemon.stop('again');
    expect(second).toBe(first);

    const caught = await first.catch((error: unknown) => error);
    expect(caught).toMatchObject({
      code: 'shutdown_failed',
      details: { failures: 1, first: 'sqlite_open' },
    });
    expect(daemon.phase).toBe('STOPPED');
    expect(daemon.status.storeOpen).toBe(false);
    expect(daemon.status.lockHeld).toBe(true);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(true);
    expect(exitCodeFor(caught)).toBe(6);
  });

  it('records an ingress close failure and still releases the lock', async () => {
    control.mode = 'ingress-close-fail';
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);
    await daemon.start();

    const caught = await daemon.stop('ingress-close').catch((error: unknown) => error);

    expect(caught).toMatchObject({
      code: 'shutdown_failed',
      details: { failures: 1, first: 'event_bus' },
    });
    expect(daemon.phase).toBe('STOPPED');
    expect(daemon.status.lockHeld).toBe(false);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
    expect(exitCodeFor(caught)).toBe(6);
  });

  it('keeps store and lock when API listen fails and scheduler.stop rejects', async () => {
    control.apiMode = 'listen-fail';
    control.mode = 'stop-reject';
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);

    const caught = await daemon.start().catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: 'http_api_start_failed' });
    expect(daemon.status.storeOpen).toBe(true);
    expect(daemon.status.lockHeld).toBe(true);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(true);

    control.apiMode = 'passthrough';
    control.mode = 'passthrough';
    forceCleanup(dir);
  });

  it('does not force release while API listen failed and scheduler.stop is pending', async () => {
    control.apiMode = 'listen-fail';
    control.mode = 'stop-hang';
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);

    const startPromise = daemon.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(daemon.status.storeOpen).toBe(true);
    expect(daemon.status.lockHeld).toBe(true);

    for (let attempt = 0; attempt < 200 && control.releaseStop === null; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const release = control.releaseStop;
    if (release === null) {
      throw new Error('stop gate was not installed');
    }
    release();
    const caught = await startPromise.catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: 'http_api_start_failed' });
    expect(daemon.status.storeOpen).toBe(false);
    expect(daemon.status.lockHeld).toBe(false);

    control.apiMode = 'passthrough';
    control.mode = 'passthrough';
  });

  it('persists API close failure from boot cleanup across a later stop', async () => {
    control.apiMode = 'listen-close-fail';
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);

    const startError = await daemon.start().catch((error: unknown) => error);
    expect(startError).toMatchObject({ code: 'http_api_start_failed' });
    expect(daemon.phase).toBe('FAILED');
    expect(daemon.status.storeOpen).toBe(true);
    expect(daemon.status.lockHeld).toBe(true);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(true);

    const stopError = await daemon.stop('startup_failed').catch((error: unknown) => error);
    expect(stopError).toMatchObject({
      code: 'shutdown_failed',
      details: { failures: 1, first: 'http_api' },
    });
    expect(exitCodeFor(stopError)).toBe(6);
    expect(daemon.status.storeOpen).toBe(true);
    expect(daemon.status.lockHeld).toBe(true);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(true);
    await expect(daemon.whenStopped()).rejects.toMatchObject({
      code: 'shutdown_failed',
      details: { failures: 1, first: 'http_api' },
    });

    control.apiMode = 'passthrough';
    forceCleanup(dir);
  });

  it('main.run returns exit code 6 when boot cleanup cannot close the API', async () => {
    control.apiMode = 'listen-close-fail';
    const dir = tempDir();
    const code = await run({
      ...TEST_POLICY_ENV,
      SOUL_DATA_DIR: dir,
    });
    expect(code).toBe(6);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(true);

    control.apiMode = 'passthrough';
    forceCleanup(dir);
  });

  it('keeps store and lock when API close rejects', async () => {
    control.apiMode = 'close-fail';
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);
    await daemon.start();

    const caught = await daemon.stop('api-close-failed').catch((error: unknown) => error);
    expect(caught).toMatchObject({
      code: 'shutdown_failed',
      details: { first: 'http_api' },
    });
    expect(daemon.phase).toBe('DRAINING');
    expect(daemon.status.components.httpApi).toBe('failed');
    expect(daemon.status.capabilities.httpApi).toBe('unavailable');
    expect(daemon.status.storeOpen).toBe(true);
    expect(daemon.status.lockHeld).toBe(true);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(true);
    forceCleanup(dir);
  });

  it('keeps store and lock when api.beginDrain rejects', async () => {
    control.apiMode = 'drain-fail';
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);
    await daemon.start();

    const caught = await daemon.stop('api-drain-failed').catch((error: unknown) => error);
    expect(caught).toMatchObject({
      code: 'shutdown_failed',
      details: { first: 'http_api' },
    });
    expect(daemon.phase).toBe('DRAINING');
    expect(daemon.status.components.httpApi).toBe('failed');
    expect(daemon.status.capabilities.httpApi).toBe('unavailable');
    expect(daemon.status.storeOpen).toBe(true);
    expect(daemon.status.lockHeld).toBe(true);
    forceCleanup(dir);
  });

  it('does not close the store when scheduler.stop rejects', async () => {
    control.mode = 'stop-reject';
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);
    await daemon.start();

    const caught = await daemon.stop('stop-failed').catch((error: unknown) => error);

    expect(caught).toMatchObject({
      code: 'shutdown_failed',
      details: { first: 'scheduler' },
    });
    expect(daemon.phase).toBe('DRAINING');
    expect(daemon.status.storeOpen).toBe(true);
    expect(daemon.status.lockHeld).toBe(true);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(true);
    expect(exitCodeFor(caught)).toBe(6);
    await expect(daemon.stop('again')).rejects.toBe(caught);

    const store = control.schedulers[0]?.store as { close(): void } | undefined;
    store?.close();
  });
});
