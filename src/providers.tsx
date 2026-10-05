import type { PropsWithChildren } from 'react';

import { RemoteFlows } from '@remoteoss/remote-flows';
import { defaultComponents } from '@remoteoss/remote-flows/default-components';

/**
 * Mode B (default): one provider, no tokens in the browser.
 *
 * `proxy.url` becomes the SDK's baseUrl verbatim, so `${origin}/api` sends
 * every call to `/api/v1/...` on our Express server, which picks the token.
 * The URL must be absolute — the SDK validates it with `new URL()` and falls
 * back to the real gateway if it doesn't parse.
 */
export function ProxyProvider({ children }: PropsWithChildren) {
  return (
    <RemoteFlows
      components={defaultComponents}
      environment="partners"
      proxy={{ url: `${window.location.origin}/api` }}
    >
      {children}
    </RemoteFlows>
  );
}

/**
 * Mode A (the client-side experiment): the browser holds a real bearer token.
 *
 * Whether this works at all is the finding. The server only serves these
 * routes when HARNESS_ALLOW_BROWSER_TOKENS=true.
 */
const getToken = (url: string) => async () => {
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status} ${body}`);
  return JSON.parse(body) as { accessToken: string; expiresIn: number };
};

export function DirectAuthProvider({
  tokenUrl,
  children,
}: PropsWithChildren<{ tokenUrl: string }>) {
  return (
    <RemoteFlows
      components={defaultComponents}
      environment="partners"
      auth={getToken(tokenUrl)}
    >
      {children}
    </RemoteFlows>
  );
}

export const AUTH_MODE: 'proxy' | 'direct' =
  import.meta.env.VITE_AUTH_MODE === 'direct' ? 'direct' : 'proxy';
