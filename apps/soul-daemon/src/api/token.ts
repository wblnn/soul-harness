/**
 * API token file handling.
 *
 * The token is a local administrative credential. It is never derived from the
 * data directory, never accepted from the environment, and never returned by an
 * HTTP endpoint. The verifier deliberately exposes only `verify()`; the raw
 * token cannot be read from this module's public surface.
 *
 * Design constraints (SH-009-PLAN §5):
 *   - created only after the single-instance lock, before the Store is opened;
 *   - POSIX file mode 0600, POSIX data-directory group/other bits zero;
 *   - existing files are opened, fstat'ed, checked and read through one fd;
 *   - no lstat-then-path-read verification path;
 *   - POSIX O_NOFOLLOW is mandatory; Windows records its ACL limitation rather
 *     than pretending Node's mode is an ACL.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';

import { DaemonError } from '../errors.js';

export const API_TOKEN_FILE_NAME = 'api.token';
export const API_TOKEN_BYTES = 32;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_TOKEN_FILE_BYTES = 128;
const TOKEN_FILE_MODE = 0o600;

/** Internal test seam; the production loadOrCreateApiToken has no options. */
export interface TokenLoadOptions {
  readonly platform?: NodeJS.Platform;
  /** `null` simulates a POSIX platform without O_NOFOLLOW. */
  readonly noFollow?: number | null;
  readonly getuid?: () => number | undefined;
  /** Test-only: runs after the first token create path before the final dataDir check. */
  readonly afterCreate?: () => void;
}

export interface ApiTokenVerifier {
  /** Constant-time comparison for a syntactically valid candidate. */
  verify(candidate: unknown): boolean;
}

interface ResolvedTokenOptions {
  readonly platform: NodeJS.Platform;
  readonly noFollow: number | null;
  readonly getuid: () => number | undefined;
  readonly afterCreate?: () => void;
}

export interface TokenDescriptorOptions {
  readonly platform: NodeJS.Platform;
  readonly getuid: () => number | undefined;
}

function resolveOptions(options: TokenLoadOptions | undefined): ResolvedTokenOptions {
  return {
    platform: options?.platform ?? process.platform,
    noFollow:
      options?.noFollow === undefined
        ? ((constants.O_NOFOLLOW as number | undefined) ?? null)
        : options.noFollow,
    getuid:
      options?.getuid ??
      ((): number | undefined =>
        typeof process.getuid === 'function' ? process.getuid() : undefined),
    ...(options?.afterCreate === undefined ? {} : { afterCreate: options.afterCreate }),
  };
}

function isPosix(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function invalid(message: string): never {
  throw new DaemonError('api_token_invalid', message);
}

function insecure(message: string): never {
  throw new DaemonError('api_token_insecure', message);
}

function ioFailed(message: string, cause: unknown): never {
  throw new DaemonError('api_token_io_failed', message, { cause });
}

/**
 * A data directory may have been created by an earlier version. Checking only
 * creation-time mode would miss chmod/chown changes, so verify it every boot.
 */
function assertSecureDataDir(dataDir: string, opts: ResolvedTokenOptions): void {
  let stat;
  try {
    stat = statSync(dataDir);
  } catch (error) {
    insecure('data directory cannot be inspected for token safety');
    throw error;
  }
  if (!stat.isDirectory()) {
    insecure('data directory must be a directory');
  }
  if (!isPosix(opts.platform)) {
    return;
  }
  if ((stat.mode & 0o077) !== 0) {
    insecure('data directory has group or other permissions');
  }
  const uid = opts.getuid();
  if (uid === undefined || stat.uid !== uid) {
    insecure('data directory is not owned by the current process user');
  }
}

function assertNoFollowAvailable(opts: ResolvedTokenOptions): void {
  if (!isPosix(opts.platform)) {
    return;
  }
  if (opts.noFollow === null || !Number.isInteger(opts.noFollow) || opts.noFollow <= 0) {
    insecure('O_NOFOLLOW is unavailable on this platform');
  }
}

function assertNonBlockingAvailable(opts: ResolvedTokenOptions): void {
  if (!isPosix(opts.platform)) {
    return;
  }
  const flag = constants.O_NONBLOCK as number | undefined;
  if (flag === undefined || !Number.isInteger(flag) || flag <= 0) {
    insecure('O_NONBLOCK is unavailable on this platform');
  }
}

function assertRegularFile(stat: Stats, platform: NodeJS.Platform): void {
  if (!stat.isFile()) {
    invalid('API token path is not a regular file');
  }
  if (platform !== 'win32' && (stat.mode & 0o7777) !== TOKEN_FILE_MODE) {
    invalid('API token file permissions must be 0600');
  }
}

function assertOwner(stat: Stats, opts: TokenDescriptorOptions): void {
  if (opts.platform === 'win32') {
    return;
  }
  const uid = opts.getuid();
  if (uid === undefined || stat.uid !== uid) {
    invalid('API token file is not owned by the current process user');
  }
}

/**
 * Reads and validates an already-open token fd. Exported for the replacement
 * race test; production always calls it through `readExistingToken`.
 */
export function readTokenFromDescriptor(fd: number, options?: TokenDescriptorOptions): string {
  const opts: TokenDescriptorOptions = {
    platform: options?.platform ?? process.platform,
    getuid:
      options?.getuid ??
      ((): number | undefined =>
        typeof process.getuid === 'function' ? process.getuid() : undefined),
  };

  let stat: Stats;
  try {
    stat = fstatSync(fd) as Stats;
  } catch (error) {
    ioFailed('API token file cannot be inspected', error);
  }
  assertRegularFile(stat, opts.platform);
  assertOwner(stat, opts);
  if (stat.size <= 0 || stat.size > MAX_TOKEN_FILE_BYTES) {
    invalid('API token file has an invalid size');
  }

  const buffer = Buffer.alloc(MAX_TOKEN_FILE_BYTES + 1);
  let total = 0;
  try {
    while (total < buffer.length) {
      const read = readSync(fd, buffer, total, buffer.length - total, total);
      if (read === 0) {
        break;
      }
      total += read;
    }
  } catch (error) {
    ioFailed('API token file cannot be read', error);
  }
  if (total > MAX_TOKEN_FILE_BYTES) {
    invalid('API token file has an invalid size');
  }

  let value = buffer.subarray(0, total).toString('utf8');
  if (value.endsWith('\n')) {
    value = value.slice(0, -1);
    if (value.endsWith('\r')) {
      value = value.slice(0, -1);
    }
  }
  if (!TOKEN_PATTERN.test(value)) {
    invalid('API token file has an invalid format');
  }
  return value;
}

function openExisting(path: string, opts: ResolvedTokenOptions): number | null {
  if (opts.platform === 'win32') {
    // Windows has no dependable O_NOFOLLOW via Node. This lstat only rejects an
    // obvious reparse point; the same-user ACL boundary remains documented.
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        insecure('API token path must not be a symbolic link');
      }
      if (!stat.isFile()) {
        invalid('API token path is not a regular file');
      }
    } catch (error) {
      if (error instanceof DaemonError) {
        throw error;
      }
      if (codeOf(error) === 'ENOENT') {
        return null;
      }
      ioFailed('API token path cannot be inspected', error);
    }
  }

  let flags: string | number;
  if (opts.platform === 'win32') {
    flags = 'r';
  } else {
    assertNoFollowAvailable(opts);
    assertNonBlockingAvailable(opts);
    flags = constants.O_RDONLY | (opts.noFollow as number) | (constants.O_NONBLOCK as number);
  }

  try {
    return openSync(path, flags);
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOENT') {
      return null;
    }
    if (code === 'ELOOP') {
      insecure('API token path must not be a symbolic link');
    }
    ioFailed('API token file cannot be opened', error);
  }
}

function readExistingToken(path: string, opts: ResolvedTokenOptions): string | null {
  const fd = openExisting(path, opts);
  if (fd === null) {
    return null;
  }
  try {
    return readTokenFromDescriptor(fd, opts);
  } finally {
    closeSync(fd);
  }
}

function createToken(path: string, opts: ResolvedTokenOptions): string {
  assertNoFollowAvailable(opts);
  assertNonBlockingAvailable(opts);
  const token = randomBytes(API_TOKEN_BYTES).toString('base64url');
  const flags =
    opts.platform === 'win32'
      ? 'wx'
      : constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (opts.noFollow as number) |
        (constants.O_NONBLOCK as number);

  let fd: number;
  try {
    fd = openSync(path, flags, TOKEN_FILE_MODE);
  } catch (error) {
    if (codeOf(error) === 'EEXIST') {
      // A concurrent first-start or a leftover file: never overwrite it.
      const existing = readExistingToken(path, opts);
      if (existing === null) {
        ioFailed('API token file disappeared during creation', error);
      }
      return existing;
    }
    ioFailed('API token file cannot be created', error);
  }

  try {
    let stat: Stats;
    try {
      stat = fstatSync(fd) as Stats;
    } catch (error) {
      ioFailed('API token file cannot be inspected after creation', error);
    }
    assertRegularFile(stat, opts.platform);
    assertOwner(stat, opts);
    try {
      const payload = Buffer.from(`${token}\n`, 'utf8');
      let offset = 0;
      while (offset < payload.length) {
        const written = writeSync(fd, payload, offset, payload.length - offset);
        if (written <= 0) {
          ioFailed('API token file write made no progress', new Error('short write'));
        }
        offset += written;
      }
      fsyncSync(fd);
    } catch (error) {
      if (error instanceof DaemonError) {
        throw error;
      }
      ioFailed('API token file cannot be written', error);
    }
  } finally {
    closeSync(fd);
  }
  return token;
}

function makeVerifier(token: string): ApiTokenVerifier {
  const expected = Buffer.from(token, 'utf8');
  return Object.freeze({
    verify(candidate: unknown): boolean {
      if (typeof candidate !== 'string') {
        return false;
      }
      const actual = Buffer.from(candidate, 'utf8');
      if (actual.length !== expected.length) {
        return false;
      }
      return timingSafeEqual(actual, expected);
    },
  });
}

/**
 * Loads or creates `<dataDir>/api.token`.
 *
 * The raw token is retained only inside the returned verifier closure. Invalid
 * existing files are never regenerated or overwritten.
 */
export function loadOrCreateApiToken(dataDir: string): ApiTokenVerifier {
  return loadOrCreateApiTokenWithOptions(dataDir, resolveOptions(undefined));
}

/** Test-only variant for platform/no-follow fault injection. */
export function loadOrCreateApiTokenForTest(
  dataDir: string,
  options: TokenLoadOptions,
): ApiTokenVerifier {
  return loadOrCreateApiTokenWithOptions(dataDir, resolveOptions(options));
}

function loadOrCreateApiTokenWithOptions(
  dataDir: string,
  opts: ResolvedTokenOptions,
): ApiTokenVerifier {
  assertSecureDataDir(dataDir, opts);
  assertNoFollowAvailable(opts);

  const path = join(dataDir, API_TOKEN_FILE_NAME);
  const existing = readExistingToken(path, opts);
  if (existing !== null) {
    return makeVerifier(existing);
  }
  const created = createToken(path, opts);
  opts.afterCreate?.();
  assertSecureDataDir(dataDir, opts);
  return makeVerifier(created);
}
