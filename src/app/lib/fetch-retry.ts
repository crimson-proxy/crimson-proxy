/* FUCK CLOUDFLARE FIX */
/**
 * Global fetch retry wrapper.
 *
 * Installs once on app boot. Every `fetch(...)` call in the React app
 * automatically retries on 5xx responses or network errors, up to 3 total
 * attempts with a short exponential backoff (300ms, 600ms).
 *
 * Why: the Cloudflare deploy occasionally returns 500 on the dashboard's
 * burst of parallel /api/* calls — Cloudflare-specific cross-request
 * socket race that Vercel doesn't have. Refreshing the page fixes it,
 * but that's a bad UX. Retrying transparently makes those flakes
 * invisible to the user.
 *
 * Only retries:
 *   - HTTP 5xx (502, 503, 504, etc. — transient server errors)
 *   - Network errors (fetch itself throws)
 *
 * Does NOT retry:
 *   - 4xx (real client errors — invalid auth, missing route, etc.)
 *   - 2xx / 3xx (already success)
 *
 * Body-consuming requests (POST with JSON body): the original Request
 * body is consumed on first attempt, so retries pass the SAME init
 * object to fetch — fetch internally re-encodes the body for each
 * call. This works for the common cases (plain object body, FormData,
 * URLSearchParams). It does NOT work for ReadableStream bodies, but
 * the dashboard doesn't use those.
 */

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 300, 600];

let installed = false;

export function installFetchRetry(): void {
  if (installed) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let lastError: unknown = null;
    let lastResponse: Response | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      }
      try {
        const res = await originalFetch(input, init);
        // Success path: any non-5xx is returned to the caller as-is.
        // 4xx (auth failures, validation errors, 404s) are NOT retried —
        // they're legitimate "no" answers and retrying wouldn't change
        // the result.
        if (res.status < 500) return res;
        lastResponse = res;
      } catch (err) {
        // Network error / DNS failure / aborted. Save and try again
        // unless we're out of attempts.
        lastError = err;
      }
    }

    // Ran out of attempts. Prefer returning the last 5xx response (so
    // callers see the real status code) over the network error.
    if (lastResponse) return lastResponse;
    throw lastError;
  };
}
