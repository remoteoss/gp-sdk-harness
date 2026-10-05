#!/usr/bin/env node
/**
 * Which paths does each token type actually reach?
 *
 *   EMPLOYMENT_ID=<id> node scripts/probe-token-paths.mjs
 *
 * Built to answer one question: T6b returned `404 {"message":"Company not
 * found"}` for the `ra_test_` customer API token on
 * `PUT /v2/employments/{id}/bank-account-details`, while the same token
 * returns 200 on `GET /v1/company-managers` for the company that owns that
 * employment. Either the token cannot see employments at all, or the v2
 * employer endpoints sit under a different base path for customer tokens —
 * Remote's own docs reference `/api/eor/v1/employments/{id}` next to plain
 * `/v1/...`.
 *
 * GETs only by default. Nothing here writes. Zero dependencies.
 */
import { GATEWAY, GATEWAY_NAME, mintAdminToken, requireEnv } from '../server/token.js';

const EMPLOYMENT_ID = process.env.EMPLOYMENT_ID;
if (!EMPLOYMENT_ID) {
  console.error('\n✖ EMPLOYMENT_ID is required.\n');
  process.exit(1);
}
requireEnv(['REMOTE_PARTNER_API_TOKEN']);

const PATHS = [
  '/v1/company-managers',
  '/v1/companies',
  `/v1/employments`,
  `/v1/employments/${EMPLOYMENT_ID}`,
  `/v2/employments/${EMPLOYMENT_ID}`,
  `/api/eor/v1/employments/${EMPLOYMENT_ID}`,
  `/api/eor/v2/employments/${EMPLOYMENT_ID}`,
  `/v1/employments/${EMPLOYMENT_ID}/onboarding-steps`,
];

const { accessToken: adminToken } = await mintAdminToken();
const TOKENS = [
  ['customer-api (ra_test_)', process.env.REMOTE_PARTNER_API_TOKEN],
  ['admin assertion', adminToken],
];

console.log(`\nToken / path reachability on ${GATEWAY_NAME}`);
console.log(`  employment ${EMPLOYMENT_ID}`);
console.log(`  GETs only — nothing is written\n`);

const width = Math.max(...PATHS.map((p) => p.length)) + 2;
console.log(`${'path'.padEnd(width)}${TOKENS.map(([n]) => n.padEnd(26)).join('')}`);
console.log('-'.repeat(width + 26 * TOKENS.length));

for (const apiPath of PATHS) {
  const cells = [];
  for (const [, token] of TOKENS) {
    try {
      const res = await fetch(`${GATEWAY}${apiPath}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      const text = await res.text();
      let msg = '';
      try {
        const j = JSON.parse(text);
        msg = j.message ? ` ${String(j.message).slice(0, 18)}` : '';
      } catch {
        /* non-JSON body; the status is the signal */
      }
      cells.push(`${res.status}${msg}`.padEnd(26));
    } catch (err) {
      cells.push(`ERR ${err.message.slice(0, 18)}`.padEnd(26));
    }
  }
  console.log(`${apiPath.padEnd(width)}${cells.join('')}`);
}

console.log(`
Reading this:
  A 404 "Company not found" on every employment path for the customer token
  means the token cannot resolve employments at all — not a path problem.
  A 200 on one of the /api/eor/... variants means the v2 employer endpoints
  simply live under a different base path for customer API tokens, and T6b
  was testing the wrong URL.
`);
