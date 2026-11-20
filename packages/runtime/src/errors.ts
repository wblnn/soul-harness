/**
 * Runtime error model for the pieces this package actually implements.
 *
 * Codes are a closed set so callers can branch without parsing message text.
 * Messages name the failed rule. They do not echo clock values, entropy, or
 * candidate identifiers: those are not stimulus content, but they are still
 * caller-controlled inputs and do not belong in a stable error string.
 */

export const RUNTIME_ERROR_CODES = [
  'invalid_argument',
  'invalid_clock',
  'invalid_entropy',
  'id_collision',
  'id_encoding',
  'not_found',
  'illegal_transition',
  'version_conflict',
] as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly details?: Readonly<Record<string, string | number>>;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, string | number>>;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RuntimeError';
    this.code = code;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }
}

/** Narrowing helper for call sites that catch unknown errors. */
export function isRuntimeError(value: unknown): value is RuntimeError {
  return value instanceof RuntimeError;
}
