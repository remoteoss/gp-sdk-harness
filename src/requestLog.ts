/**
 * Client-side request log, for Mode A only.
 *
 * In Mode B every call goes through the Express proxy, which records method,
 * path, status and token type to results/proxy-log.jsonl. Mode A removes the
 * proxy — the browser talks directly to the gateway — so that record does not
 * exist and the only evidence would be a screenshot of the network tab.
 *
 * This patches `window.fetch` to keep the same facts in memory so the Employee
 * tab can render them and they can be copied out. A CORS failure
 * rejects the fetch with an opaque TypeError and no status, which is itself the
 * signal we are looking for, so failures are recorded as carefully as statuses.
 *
 * Only installed when VITE_AUTH_MODE=direct. Never active in Mode B.
 */
export type LoggedRequest = {
  n: number;
  ts: string;
  method: string;
  url: string;
  /** Same-origin calls are the harness's own /local/token/* routes. */
  crossOrigin: boolean;
  status: number | null;
  /** Set when the fetch itself rejected — CORS, DNS, offline. */
  error: string | null;
  durationMs: number;
};

const entries: LoggedRequest[] = [];
const listeners = new Set<() => void>();
let installed = false;
let counter = 0;

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getRequests(): LoggedRequest[] {
  return entries;
}

export function asText(): string {
  return entries
    .map(
      (e) =>
        `${e.ts.slice(11, 23)}  ${e.method.padEnd(6)} ${
          e.status === null ? 'FAILED' : String(e.status).padStart(6)
        }  ${e.crossOrigin ? 'cross-origin' : 'same-origin '}  ${e.url}${
          e.error ? `\n              ${e.error}` : ''
        }`,
    )
    .join('\n');
}

export function installRequestLog(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const original = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (
      init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
    ).toUpperCase();

    let crossOrigin = false;
    try {
      crossOrigin = new URL(url, window.location.origin).origin !== window.location.origin;
    } catch {
      /* unparseable URL; treat as same-origin and let the request speak */
    }

    const started = performance.now();
    const n = (counter += 1);

    const record = (status: number | null, error: string | null) => {
      entries.push({
        n,
        ts: new Date().toISOString(),
        method,
        url,
        crossOrigin,
        status,
        error,
        durationMs: Math.round(performance.now() - started),
      });
      listeners.forEach((fn) => fn());
    };

    try {
      const res = await original(input, init);
      record(res.status, null);
      return res;
    } catch (err) {
      // A blocked cross-origin request lands here with no status. The browser
      // deliberately withholds the detail; the console shows the real reason.
      record(
        null,
        `${(err as Error).name}: ${(err as Error).message}` +
          (crossOrigin ? ' — likely CORS; check the browser console for the blocked header or origin' : ''),
      );
      throw err;
    }
  };
}
