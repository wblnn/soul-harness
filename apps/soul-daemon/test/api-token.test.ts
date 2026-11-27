import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  chmodSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isDaemonError } from '../src/errors.js';
import {
  API_TOKEN_FILE_NAME,
  loadOrCreateApiToken,
  loadOrCreateApiTokenForTest,
  readTokenFromDescriptor,
} from '../src/api/token.js';
import { makeTempDir, removeTempDir } from './helpers/harness.js';

const dirs: string[] = [];
const isPosix = process.platform !== 'win32';

function tempDir(): string {
  const dir = makeTempDir('sh-api-token-');
  dirs.push(dir);
  return dir;
}

function tokenPath(dir: string): string {
  return join(dir, API_TOKEN_FILE_NAME);
}

function readToken(dir: string): string {
  return readFileSync(tokenPath(dir), 'utf8').replace(/\r?\n$/u, '');
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    expect(isDaemonError(error)).toBe(true);
    return isDaemonError(error) ? error.code : undefined;
  }
}

afterEach(() => {
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
});

describe('API token lifecycle', () => {
  it('creates a 32-byte base64url token, persists it, and verifies it in memory', () => {
    const dir = tempDir();
    const verifier = loadOrCreateApiToken(dir);
    const token = readToken(dir);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(statSync(tokenPath(dir)).size).toBe(44);
    expect(verifier.verify(token)).toBe(true);
    expect(verifier.verify(`${token}x`)).toBe(false);
    expect(verifier.verify(undefined)).toBe(false);
    expect(JSON.stringify(verifier)).not.toContain(token);

    if (isPosix) {
      expect(statSync(tokenPath(dir)).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o077).toBe(0);
    }
  });

  it('reuses a valid existing token without regenerating it', () => {
    const dir = tempDir();
    const first = loadOrCreateApiToken(dir);
    const token = readToken(dir);
    const second = loadOrCreateApiToken(dir);

    expect(second.verify(token)).toBe(true);
    expect(first.verify(token)).toBe(true);
    expect(readToken(dir)).toBe(token);
  });

  it('fails closed for malformed existing files and never overwrites them', () => {
    const dir = tempDir();
    writeFileSync(tokenPath(dir), 'not-a-token', { encoding: 'utf8', mode: 0o600 });
    expect(codeOf(() => loadOrCreateApiToken(dir))).toBe('api_token_invalid');
    expect(readFileSync(tokenPath(dir), 'utf8')).toBe('not-a-token');
  });

  it('rejects an oversized token file', () => {
    const dir = tempDir();
    writeFileSync(tokenPath(dir), 'a'.repeat(129), { encoding: 'utf8', mode: 0o600 });
    expect(codeOf(() => loadOrCreateApiToken(dir))).toBe('api_token_invalid');
  });

  it('rejects a directory at the token path', () => {
    const dir = tempDir();
    mkdirSync(tokenPath(dir));
    expect(codeOf(() => loadOrCreateApiToken(dir))).toBe('api_token_invalid');
  });

  it.skipIf(!isPosix)(
    'rejects a FIFO without blocking on POSIX',
    () => {
      const dir = tempDir();
      execFileSync('mkfifo', [tokenPath(dir)], { stdio: 'ignore' });
      expect(codeOf(() => loadOrCreateApiToken(dir))).toBe('api_token_invalid');
    },
    10_000,
  );

  it.skipIf(!isPosix)('rejects a device fd at the descriptor boundary', () => {
    if (!existsSync('/dev/null')) {
      return;
    }
    const fd = openSync('/dev/null', 'r');
    try {
      expect(
        codeOf(() =>
          readTokenFromDescriptor(fd, {
            platform: process.platform,
            getuid: () => (typeof process.getuid === 'function' ? process.getuid() : undefined),
          }),
        ),
      ).toBe('api_token_invalid');
    } finally {
      closeSync(fd);
    }
  });

  it.skipIf(!isPosix)('rejects a symlink instead of reading its target', () => {
    const dir = tempDir();
    const target = join(dir, 'target.token');
    writeFileSync(target, `${'a'.repeat(43)}\n`, { encoding: 'utf8', mode: 0o600 });
    symlinkSync(target, tokenPath(dir));

    expect(codeOf(() => loadOrCreateApiToken(dir))).toBe('api_token_insecure');
  });

  it.skipIf(!isPosix)('requires O_NOFOLLOW on POSIX', () => {
    const dir = tempDir();
    expect(
      codeOf(() =>
        loadOrCreateApiTokenForTest(dir, {
          platform: 'linux',
          noFollow: null,
        }),
      ),
    ).toBe('api_token_insecure');
  });

  it.skipIf(!isPosix)('rejects existing file modes other than 0600', () => {
    const dir = tempDir();
    loadOrCreateApiToken(dir);
    chmodSync(tokenPath(dir), 0o644);
    expect(codeOf(() => loadOrCreateApiToken(dir))).toBe('api_token_invalid');

    chmodSync(tokenPath(dir), 0o400);
    expect(codeOf(() => loadOrCreateApiToken(dir))).toBe('api_token_invalid');
  });

  it.skipIf(!isPosix)('rejects setuid, setgid and sticky permission bits', () => {
    const dir = tempDir();
    loadOrCreateApiToken(dir);
    let tested = 0;
    for (const mode of [0o4600, 0o2600, 0o1600]) {
      chmodSync(tokenPath(dir), mode);
      const actual = statSync(tokenPath(dir)).mode & 0o7777;
      if (actual !== mode) {
        // The filesystem refused to preserve this special bit; do not claim
        // coverage that was not actually established.
        continue;
      }
      tested += 1;
      expect(
        codeOf(() => loadOrCreateApiToken(dir)),
        `mode 0${mode.toString(8)}`,
      ).toBe('api_token_invalid');
    }
    expect(tested).toBeGreaterThan(0);
  });

  it.skipIf(!isPosix)('rechecks the data directory after first creating the token', () => {
    const dir = tempDir();
    let hookRan = false;
    const code = codeOf(() =>
      loadOrCreateApiTokenForTest(dir, {
        platform: process.platform,
        afterCreate: () => {
          hookRan = true;
          chmodSync(dir, 0o755);
        },
      }),
    );
    expect(hookRan).toBe(true);
    expect(code).toBe('api_token_insecure');
    expect(existsSync(tokenPath(dir))).toBe(true);
  });
  it.skipIf(!isPosix)('rejects an existing data directory with group/other permissions', () => {
    const dir = tempDir();
    loadOrCreateApiToken(dir);
    chmodSync(dir, 0o755);
    expect(codeOf(() => loadOrCreateApiToken(dir))).toBe('api_token_insecure');
  });

  it.skipIf(!isPosix)(
    'rejects a data directory whose owner does not match the process user',
    () => {
      const dir = tempDir();
      const otherUid = (typeof process.getuid === 'function' ? process.getuid() : 0) + 1;
      expect(
        codeOf(() =>
          loadOrCreateApiTokenForTest(dir, {
            platform: 'linux',
            getuid: () => otherUid,
          }),
        ),
      ).toBe('api_token_insecure');
    },
  );

  it('reads through the already-open fd, not a path replaced after open', () => {
    const dir = tempDir();
    loadOrCreateApiToken(dir);
    const oldToken = readToken(dir);
    const fd = openSync(tokenPath(dir), 'r');
    try {
      renameSync(tokenPath(dir), join(dir, 'old.token'));
      writeFileSync(tokenPath(dir), `${'b'.repeat(43)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      const read = readTokenFromDescriptor(fd, {
        platform: process.platform,
        getuid: () => (typeof process.getuid === 'function' ? process.getuid() : undefined),
      });
      expect(read).toBe(oldToken);
    } finally {
      closeSync(fd);
    }
  });
});
