/**
 * Thrown by an ApiClient when the requested object (node, VM/CT) does not exist,
 * as opposed to a transient/network failure. UI code uses `isNotFoundError` to show
 * a "not found" empty state (with a link back) instead of a retryable error state.
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export function isNotFoundError(error: unknown): error is NotFoundError {
  return error instanceof NotFoundError;
}

/** Best-effort human-readable message for an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Unknown error';
}
