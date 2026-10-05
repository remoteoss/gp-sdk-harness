/**
 * The only token logic in this project.
 *
 * Mirrors example/api/jwt_auth.js on remote-flows main: Basic auth header,
 * `scope` in both the JWT and the form body, HS256 signed with the client
 * secret, assertion lifetime under 10 minutes.
 *
 * Two identities come out of the same function; only the `sub` differs.
 *
 * ZERO DEPENDENCIES ON PURPOSE. A minimum-package-age supply-chain policy can
 * block `npm install`, which would
 * otherwise take the token service, the mint CLI, the seeder, the fixture
 * capture and the whole bank matrix down with it. None of that needs the SDK,
 * so none of it should need node_modules either. `dotenv` is replaced by a
 * small parser below and `jsonwebtoken` by node:crypto — an HS256 JWT is a
 * base64url header, a base64url payload and an HMAC over the two.
 *
 * Express, React and the SDK are still real dependencies, but only the
 * browser flows need them.
 */
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..');

/* ------------------------------------------------------------------ *
 * .env
 *
 * The operator owns .env. We only ever read it, and we never overwrite a value
 * already present in the real environment.
 * ------------------------------------------------------------------ */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!key || key in process.env) continue;

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.includes('#')) {
      // Deliberate deviation from dotenv, which truncates an unquoted value at
      // the first '#'. A client secret containing '#' would be silently cut
      // short and present as an auth failure with no clue why. We keep the
      // whole value and say so instead — a real trailing comment then fails
      // loudly, which is the better of the two wrong outcomes.
      console.warn(
        `[env] ${key} contains a '#'. Keeping the value whole. If that was ` +
          `meant as a trailing comment, quote the value instead.`,
      );
    }
    process.env[key] = value;
  }
}

loadEnvFile(path.join(PROJECT_ROOT, '.env'));

/* ------------------------------------------------------------------ *
 * Gateway — sandbox only
 * ------------------------------------------------------------------ */
const GATEWAYS = {
  partners: 'https://gateway.partners.remote-sandbox.com',
  sandbox: 'https://gateway.remote-sandbox.com',
};

const env = process.env.REMOTE_GATEWAY ?? 'partners';
if (!GATEWAYS[env]) {
  throw new Error(
    `Refusing gateway "${env}" — sandbox environments only (${Object.keys(GATEWAYS).join(', ')}).`,
  );
}

export const GATEWAY_NAME = env;
export const GATEWAY = GATEWAYS[env];

/* ------------------------------------------------------------------ *
 * HS256 JWT
 * ------------------------------------------------------------------ */
const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Sign an HS256 JWT. Byte-identical to
 * `jsonwebtoken.sign(payload, secret, { algorithm: 'HS256' })` for the same
 * claims — verified against that library in the harness's offline checks.
 */
export function signHS256(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${body}.${signature}`;
}

/* ------------------------------------------------------------------ *
 * Subjects, redaction, env checks
 * ------------------------------------------------------------------ */
/** `${sub}|${scope}` -> { accessToken, expiresIn, expiresAt } */
const cache = new Map();

export const adminSub = () =>
  `urn:remote-api:company-manager:user:${process.env.REMOTE_OWNER_USER_ID}`;

// Note the spelling: `employment`. An older internal spec, and the public API
// reference example, both write "emplomyent".
export const employeeSub = (employmentId) =>
  `urn:remote-api:employee:employment:${employmentId}`;

/** Never log a whole token. */
export const redact = (token) =>
  typeof token === 'string' && token.length > 0
    ? `${token.slice(0, 8)}…(length ${token.length})`
    : '<empty>';

export function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(
      `Missing required .env values: ${missing.join(', ')}. ` +
        `.env is written by the operator — do not guess these. See .env.example.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Token exchange
 * ------------------------------------------------------------------ */
/**
 * Exchange a signed assertion for an access token.
 *
 * @param {string} sub    adminSub() or employeeSub(employmentId)
 * @param {string} scope  goes into both the JWT claim and the form body
 * @param {{ noCache?: boolean }} [opts]
 */
export async function mintToken(sub, scope = 'all:write', opts = {}) {
  const key = `${sub}|${scope}`;
  if (!opts.noCache) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt - 60_000 > Date.now()) return hit;
  }

  requireEnv(['REMOTE_CLIENT_ID', 'REMOTE_CLIENT_SECRET']);
  const { REMOTE_CLIENT_ID: id, REMOTE_CLIENT_SECRET: secret } = process.env;

  const now = Math.floor(Date.now() / 1000);
  const assertion = signHS256(
    {
      iss: id,
      sub,
      aud: `${GATEWAY}/auth`,
      scope,
      iat: now,
      exp: now + 5 * 60, // well inside the gateway's strict 10-minute bound
    },
    secret,
  );

  const res = await fetch(`${GATEWAY}/auth/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
      scope,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(
      new Error(`Token exchange failed: HTTP ${res.status} ${text}`),
      { status: res.status, body: text, sub, scope },
    );
  }

  const d = JSON.parse(text);
  const token = {
    accessToken: d.access_token,
    expiresIn: d.expires_in,
    expiresAt: Date.now() + d.expires_in * 1000,
    scope: d.scope ?? scope,
    sub,
  };
  cache.set(key, token);
  return token;
}

/** Convenience wrappers so callers never hand-build a subject string. */
export const mintAdminToken = (scope, opts) => {
  requireEnv(['REMOTE_OWNER_USER_ID']);
  return mintToken(adminSub(), scope, opts);
};

export const mintEmployeeToken = (employmentId, scope, opts) => {
  if (!employmentId) throw new Error('mintEmployeeToken needs an employmentId');
  return mintToken(employeeSub(employmentId), scope, opts);
};
