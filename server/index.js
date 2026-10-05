/**
 * Harness server.
 *
 *   /api/*   one-rule proxy to the gateway (Mode B, the default)
 *   /local/* token endpoints for the Mode A direct-auth experiment (off by default)
 *   /health  what the harness thinks it is pointed at
 *
 * Importing ./token.js loads .env and throws if REMOTE_GATEWAY is anything
 * other than a sandbox gateway, so a production misconfiguration never gets
 * as far as listening on a port.
 */
import express from 'express';

import { proxy } from './proxy.js';
import {
  GATEWAY,
  GATEWAY_NAME,
  mintAdminToken,
  mintEmployeeToken,
  redact,
  requireEnv,
} from './token.js';

const PORT = Number(process.env.HARNESS_PORT ?? 3001);
const ALLOW_BROWSER_TOKENS = process.env.HARNESS_ALLOW_BROWSER_TOKENS === 'true';

const app = express();

app.get('/health', (_req, res) => {
  res.json({
    gateway: GATEWAY_NAME,
    gatewayUrl: GATEWAY,
    authMode: process.env.VITE_AUTH_MODE ?? 'proxy',
    browserTokensAllowed: ALLOW_BROWSER_TOKENS,
    companyId: process.env.VITE_COMPANY_ID ?? null,
    ownerUserIdPresent: Boolean(process.env.REMOTE_OWNER_USER_ID),
    partnerApiTokenPresent: Boolean(process.env.REMOTE_PARTNER_API_TOKEN),
  });
});

/**
 * Mode A only. These hand a real bearer token to the browser, which is
 * exactly what we are trying to find out the consequences of — so they stay
 * behind an explicit flag and answer 403 otherwise.
 */
const browserTokenGuard = (_req, res, next) => {
  if (!ALLOW_BROWSER_TOKENS) {
    return res.status(403).json({
      error:
        'Browser tokens are disabled. Set HARNESS_ALLOW_BROWSER_TOKENS=true in .env to run the Mode A experiment.',
    });
  }
  next();
};

app.get('/local/token/admin', browserTokenGuard, async (_req, res) => {
  try {
    const { accessToken, expiresIn } = await mintAdminToken();
    console.log(`[local] admin token issued ${redact(accessToken)} expires_in=${expiresIn}`);
    res.json({ accessToken, expiresIn });
  } catch (err) {
    console.error('[local] admin token failed:', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

app.get('/local/token/employee/:employmentId', browserTokenGuard, async (req, res) => {
  try {
    const { accessToken, expiresIn } = await mintEmployeeToken(req.params.employmentId);
    console.log(
      `[local] employee token issued for ${req.params.employmentId} ${redact(accessToken)} expires_in=${expiresIn}`,
    );
    res.json({ accessToken, expiresIn });
  } catch (err) {
    console.error('[local] employee token failed:', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// Express 5: mount the router on a path prefix. A '*' route is a syntax error here.
app.use('/api', proxy);

try {
  requireEnv(['REMOTE_CLIENT_ID', 'REMOTE_CLIENT_SECRET', 'REMOTE_OWNER_USER_ID', 'VITE_COMPANY_ID']);
} catch (err) {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`\nGP SDK harness server on http://localhost:${PORT}`);
  console.log(`  gateway            ${GATEWAY_NAME} → ${GATEWAY}`);
  console.log(`  company            ${process.env.VITE_COMPANY_ID}`);
  console.log(`  auth mode          ${process.env.VITE_AUTH_MODE ?? 'proxy'}`);
  console.log(`  browser tokens     ${ALLOW_BROWSER_TOKENS ? 'ALLOWED (Mode A)' : 'blocked'}`);
  console.log(`  proxy rule         /v1/employee/* → employee token, everything else → admin token\n`);
});
