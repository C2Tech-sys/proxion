import { QueryClient } from '@tanstack/react-query';

import { isNotFoundError } from '@/api/errors';

/**
 * Shared react-query configuration.
 *
 * The default react-query policy (3 retries with 1s/2s/4s exponential backoff) is wrong for
 * this app: a `NotFoundError` is a definitive answer from the API, not a transient failure, so
 * retrying it only keeps a skeleton on screen for ~7.5s before the "not found" empty state can
 * render. Here a NotFoundError is never retried (the not-found state paints on the first
 * settle), and everything else gets at most `MAX_QUERY_RETRIES` quick retries.
 *
 * Exported as a factory (not a module-level singleton) so tests can build a fresh, isolated
 * cache per test while still exercising the *production* retry policy.
 */

/** Retries after the initial attempt, for errors that are not `NotFoundError`. */
export const MAX_QUERY_RETRIES = 2;

/** First retry delay; doubles per attempt, capped by `MAX_QUERY_RETRY_DELAY_MS`. */
export const QUERY_RETRY_BASE_DELAY_MS = 250;
export const MAX_QUERY_RETRY_DELAY_MS = 1000;

/** `retry`: never retry a definitive not-found; otherwise allow a couple of quick attempts. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isNotFoundError(error)) return false;
  return failureCount < MAX_QUERY_RETRIES;
}

/** `retryDelay`: 250ms, 500ms (capped at 1s) -- short enough to stay under a 1s not-found budget. */
export function queryRetryDelay(attemptIndex: number): number {
  return Math.min(QUERY_RETRY_BASE_DELAY_MS * 2 ** attemptIndex, MAX_QUERY_RETRY_DELAY_MS);
}

/** Builds a QueryClient with the app-wide retry policy. Used by main.tsx and by render tests. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
      },
    },
  });
}
