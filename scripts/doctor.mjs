#!/usr/bin/env node
/**
 * Preflight. Runs every cheap check before the token exchange, then diagnoses
 * the exchange itself against Remote's documented error semantics.
 *
 *   node scripts/doctor.mjs
 *
 * Zero dependencies — works with an empty node_modules, which is the point
 * if an install policy makes the SDK unavailable.
 *
 * Never prints a secret. Values are reported by length and shape only.
 */
import fs from 'node:fs';
import path from 'node:path';

import { GATEWAY, GATEWAY_NAME, PROJECT_ROOT, adminSub, mintAdminToken, redact } from '../server/token.js';

let problems = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const bad = (m) => {
  problems += 1;
  console.log(`  ✖ ${m}`);
};

console.log(`\nGP SDK harness — preflight\n`);

/* 1. Node ---------------------------------------------------------- */
console.log('Node');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 20 || (major === 20 && minor >= 19)) ok(`v${process.versions.node}`);
else bad(`v${process.versions.node} — need 20.19+ or 22.12+`);

/* 2. Dependencies -------------------------------------------------- */
console.log('\nDependencies');
const hasModules = fs.existsSync(path.join(PROJECT_ROOT, 'node_modules'));
if (hasModules) {
  ok('node_modules present — the browser UI flows can run');
} else {
  warn('node_modules absent — expected if an install policy blocks the SDK');
  console.log('      Still available with no install: doctor, mint, seed, fixture, test:bank');
  console.log('      Not available: npm run dev, the admin/employee UI flows');
}

/* 3. .env ---------------------------------------------------------- */
console.log('\n.env');
const envPath = path.join(PROJECT_ROOT, '.env');
if (!fs.existsSync(envPath)) {
  bad('.env is missing. The operator writes it — do not create one.');
} else {
  const required = [
    'REMOTE_GATEWAY',
    'REMOTE_CLIENT_ID',
    'REMOTE_CLIENT_SECRET',
    'REMOTE_OWNER_USER_ID',
    'REMOTE_PARTNER_API_TOKEN',
    'VITE_COMPANY_ID',
    'VITE_AUTH_MODE',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) bad(`missing: ${missing.join(', ')}`);
  else ok(`all ${required.length} required values present`);

  // Ground rule 2: no secret may sit behind a VITE_ prefix.
  const leaked = Object.keys(process.env).filter(
    (k) => k.startsWith('VITE_') && /SECRET|TOKEN|PASSWORD|CLIENT_ID/i.test(k),
  );
  if (leaked.length) bad(`secret exposed to the browser via VITE_ prefix: ${leaked.join(', ')}`);
  else ok('no secret behind a VITE_ prefix');

  const shape = (v) => {
    if (!v) return 'empty';
    const bits = [`len ${v.length}`];
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) bits.push('uuid');
    else if (/^[a-z0-9]{20,30}$/.test(v)) bits.push('cognito-style id');
    else if (/^[A-Za-z0-9+/]+=*$/.test(v)) bits.push('base64-ish');
    if (v.includes('#')) bits.push("contains '#'");
    if (/\s/.test(v)) bits.push('contains whitespace');
    return bits.join(', ');
  };

  console.log(`      REMOTE_CLIENT_ID         ${shape(process.env.REMOTE_CLIENT_ID)}`);
  console.log(`      REMOTE_CLIENT_SECRET     ${shape(process.env.REMOTE_CLIENT_SECRET)}`);
  console.log(`      REMOTE_OWNER_USER_ID     ${shape(process.env.REMOTE_OWNER_USER_ID)}`);
  console.log(`      VITE_COMPANY_ID          ${shape(process.env.VITE_COMPANY_ID)}`);
  console.log(
    `      REMOTE_PARTNER_API_TOKEN ${process.env.REMOTE_PARTNER_API_TOKEN?.startsWith('ra_test_') ? 'ra_test_ customer API token' : 'NOT an ra_test_ token'}`,
  );
  console.log(
    `\n      Compare REMOTE_CLIENT_ID against the client_id shown on the integration's\n` +
      `      integration record. A stale or swapped pair looks exactly like a gate problem.`,
  );
}

/* 4. Gateway and clock --------------------------------------------- */
console.log(`\nGateway (${GATEWAY_NAME})`);
let gatewayUp = false;
try {
  const res = await fetch(`${GATEWAY}/auth/oauth2/token`, { method: 'OPTIONS' });
  gatewayUp = true;
  ok(`${GATEWAY} reachable`);
  const serverDate = res.headers.get('date');
  if (serverDate) {
    const skew = Math.abs(Date.now() - new Date(serverDate).getTime());
    if (skew < 30_000) ok(`clock within ${Math.round(skew / 1000)}s of the gateway`);
    else bad(`clock is ${Math.round(skew / 1000)}s off the gateway — the assertion may be rejected`);
  }
} catch (err) {
  bad(`${GATEWAY} unreachable: ${err.message}`);
}

/* 5. Customer API token -------------------------------------------- */
if (gatewayUp && process.env.REMOTE_PARTNER_API_TOKEN) {
  console.log('\nCustomer API token (ra_test_)');
  try {
    const res = await fetch(`${GATEWAY}/v1/company-managers`, {
      headers: { Authorization: `Bearer ${process.env.REMOTE_PARTNER_API_TOKEN}` },
    });
    if (!res.ok) {
      bad(`GET /v1/company-managers -> HTTP ${res.status}. The token may have been rotated.`);
    } else {
      ok(`GET /v1/company-managers -> 200`);
      const body = await res.json();
      const owner = (body?.data?.company_managers ?? []).find((m) => m.role === 'owner');
      if (!owner) warn('no manager with role "owner" returned');
      else {
        if (owner.user_id === process.env.REMOTE_OWNER_USER_ID)
          ok('REMOTE_OWNER_USER_ID matches the live owner user_id');
        else
          bad(
            `REMOTE_OWNER_USER_ID does not match the live owner user_id — ` +
              `this is the Sep 17 user-ID / employment-ID mix-up`,
          );
        if (owner.user_status && owner.user_status !== 'active')
          warn(
            `owner user_status is "${owner.user_status}". Whether the assertion grant ` +
              `requires an active user is undocumented — worth noting if the exchange fails.`,
          );
      }
    }

    /**
     * The check above is not sufficient on its own, and once wasn't.
     *
     * A token from a DIFFERENT company returned a company-managers entry whose
     * company_id matched VITE_COMPANY_ID, so this section reported all-green
     * while the token could not see the test company's employments at all.
     * That cost a false T6b result. Ask the token which companies it actually
     * has, which is the question that matters.
     */
    const companies = await fetch(`${GATEWAY}/v1/companies`, {
      headers: { Authorization: `Bearer ${process.env.REMOTE_PARTNER_API_TOKEN}` },
    });
    if (!companies.ok) {
      warn(`GET /v1/companies -> HTTP ${companies.status}; cannot verify the token's company scope`);
    } else {
      const body = await companies.json();
      const list = body?.data?.companies ?? (Array.isArray(body?.data) ? body.data : []);
      const ids = list.map((c) => c.id ?? c.slug);
      if (ids.includes(process.env.VITE_COMPANY_ID)) {
        ok(`the token's company scope includes VITE_COMPANY_ID (${ids.length} company/companies)`);
      } else {
        bad(
          `the token is scoped to a DIFFERENT company — it cannot see VITE_COMPANY_ID.\n` +
            `      token sees: ${list.map((c) => `${c.id ?? c.slug} (${c.name ?? '?'})`).join(', ') || 'none'}\n` +
            `      .env wants: ${process.env.VITE_COMPANY_ID}\n` +
            `      Generate a new ra_test_ token from the GP SDK Harness company's own\n` +
            `      dashboard. T6b and T8 cannot work until then.`,
        );
      }
    }
  } catch (err) {
    bad(`customer API token checks failed: ${err.message}`);
  }
}

/* 6. The assertion exchange ---------------------------------------- */
if (gatewayUp) {
  console.log('\nAssertion grant (the core acceptance check)');
  console.log(`      sub ${adminSub()}`);
  console.log(`      aud ${GATEWAY}/auth`);
  try {
    const token = await mintAdminToken('all:write', { noCache: true });
    ok(`token issued — expires_in ${token.expiresIn}, ${redact(token.accessToken)}`);
    if (token.expiresIn < 600) warn(`expires_in ${token.expiresIn} is lower than the ~3600 expected`);
  } catch (err) {
    bad(err.message.split('\n')[0]);
    diagnose(err.body ?? '');
  }
}

/**
 * Map the response onto Remote's documented error semantics.
 *
 * The decisive signal: every claim-level failure carries an `error_description`.
 * A bare `invalid_grant` is what is left when no claim check fired, which
 * points at the integration-level gate rather than anything in the JWT.
 */
function diagnose(body) {
  let parsed = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    /* leave empty; we fall through to the generic advice */
  }
  const error = parsed.error ?? '';
  const description = parsed.error_description ?? '';

  console.log('');
  if (description) {
    console.log(`      error_description: "${description}"`);
    const table = [
      [/expiration/i, 'The exp claim is out of range. The gateway allows under 10 minutes; we send 5.'],
      [/issuer/i, 'The iss claim does not match the client_id. Check REMOTE_CLIENT_ID against the integration record.'],
      [/audience/i, `The aud claim must be exactly ${GATEWAY}/auth.`],
      [
        /subject|scope/i,
        'The sub format is unrecognised, or the scope is not valid for that subject role. ' +
          'Admin subjects are urn:remote-api:company-manager:user:<user_id>.',
      ],
    ];
    const hit = table.find(([re]) => re.test(description));
    console.log(`      → ${hit ? hit[1] : 'Claim-level rejection; the description above names the claim.'}`);
    return;
  }

  if (error === 'unsupported_grant_type') {
    console.log('      → The client is not enabled for the jwt-bearer grant at all.');
    console.log('        Stop: this client is not enabled for the jwt-bearer grant.');
    return;
  }
  if (error === 'unauthorized_client' || error === 'invalid_grant') {
    console.log(
      `      → No error_description, so no claim check fired. This response is\n` +
        `        OVERLOADED — verified 2026-09-30, the same bare body comes back for at\n` +
        `        least four distinct causes, so work through them in this order:\n\n` +
        `        1. The integration is not permitted the assertion grant.\n` +
        `           Check the "Create assertion tokens" setting on the integration in\n` +
        `           the integration's settings in the internal integrations backoffice.\n` +
        `           This was the actual cause the first time it was hit here.\n\n` +
        `        2. The subject's company is not one this client manages.\n` +
        `           Confirmed by scripts/probe-isolation.mjs — a company-manager or\n` +
        `           employment subject outside the client's companies is refused with\n` +
        `           exactly this body.\n\n` +
        `        3. The subject does not exist at all. A random employment UUID is\n` +
        `           refused identically, so a typo in the ID looks like a gate problem.\n\n` +
        `        4. Bad or rotated client credentials. Remote's error codes do not\n` +
        `           reliably return invalid_client for this, so compare\n` +
        `           REMOTE_CLIENT_ID against the client_id on the integration record.\n\n` +
        `        Note on descriptions: a MALFORMED sub URN does come back with an\n` +
        `        error_description ("Subject or Scope validation failed"), but a\n` +
        `        well-formed sub that fails to resolve or is not authorised comes back\n` +
        `        bare. So a missing description does not rule the subject out — check\n` +
        `        the URN spelling first, then the ID itself.`,
    );
    return;
  }
  if (error === 'invalid_client') {
    console.log('      → Credentials rejected. Check the pair, and whether they belong to');
    console.log('        a different environment or an earlier credential rotation.');
    return;
  }
  console.log(`      → Unrecognised response. Record it verbatim before changing anything.`);
}

/* Summary ---------------------------------------------------------- */
console.log(
  problems === 0
    ? '\nAll checks passed.\n'
    : `\n${problems} problem${problems === 1 ? '' : 's'}. Fix the ✖ lines above before running the matrix.\n`,
);
process.exit(problems ? 1 : 0);
