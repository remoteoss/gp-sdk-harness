#!/usr/bin/env node
/**
 * What does each token actually see?
 *
 *   EMPLOYMENT_ID=<id> node scripts/probe-token-scope.mjs
 *
 * Follow-up to probe-token-paths.mjs, which showed the `ra_test_` customer
 * token can LIST employments (200) but gets `404 {"message":"Company not
 * found"}` fetching one specific employment that the admin assertion token
 * reads fine. That is either a scoping boundary with a misleading error
 * message, or the token belongs to a different company than assumed.
 *
 * This lists the companies and employments each token can see and says
 * whether the employment under test is among them. GETs only.
 */
import { GATEWAY, GATEWAY_NAME, mintAdminToken, requireEnv } from '../server/token.js';

const EMPLOYMENT_ID = process.env.EMPLOYMENT_ID;
if (!EMPLOYMENT_ID) {
  console.error('\n✖ EMPLOYMENT_ID is required.\n');
  process.exit(1);
}
requireEnv(['REMOTE_PARTNER_API_TOKEN', 'VITE_COMPANY_ID']);

const { accessToken: adminToken } = await mintAdminToken();
const TOKENS = [
  ['customer-api (ra_test_)', process.env.REMOTE_PARTNER_API_TOKEN],
  ['admin assertion', adminToken],
];

async function get(apiPath, token) {
  const res = await fetch(`${GATEWAY}${apiPath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, json, text };
}

const pick = (obj, keys) => keys.map((k) => obj?.[k]).find((v) => v !== undefined);

console.log(`\nToken scope on ${GATEWAY_NAME}`);
console.log(`  .env VITE_COMPANY_ID  ${process.env.VITE_COMPANY_ID}`);
console.log(`  employment under test ${EMPLOYMENT_ID}\n`);

for (const [label, token] of TOKENS) {
  console.log(`${'='.repeat(64)}\n${label}\n`);

  const companies = await get('/v1/companies', token);
  const cList =
    pick(companies.json?.data ?? {}, ['companies']) ??
    (Array.isArray(companies.json?.data) ? companies.json.data : []);
  console.log(`  GET /v1/companies -> ${companies.status}`);
  if (Array.isArray(cList)) {
    console.log(`    ${cList.length} company/companies:`);
    for (const c of cList.slice(0, 10)) {
      const id = c.id ?? c.slug;
      const mark = id === process.env.VITE_COMPANY_ID ? '  <-- .env VITE_COMPANY_ID' : '';
      console.log(`      ${id}  ${c.name ?? ''}${mark}`);
    }
    if (!cList.some((c) => (c.id ?? c.slug) === process.env.VITE_COMPANY_ID)) {
      console.log(`      !! VITE_COMPANY_ID is NOT in this list`);
    }
  }

  const employments = await get('/v1/employments', token);
  const eData = employments.json?.data ?? {};
  const eList = pick(eData, ['employments']) ?? (Array.isArray(eData) ? eData : []);
  const total = eData.total_count ?? (Array.isArray(eList) ? eList.length : '?');
  console.log(`\n  GET /v1/employments -> ${employments.status}   total_count=${total}`);
  if (Array.isArray(eList)) {
    for (const e of eList.slice(0, 10)) {
      const mark = e.id === EMPLOYMENT_ID ? '  <-- the employment under test' : '';
      console.log(`      ${e.id}  status=${e.status ?? '?'}  type=${e.type ?? '?'}${mark}`);
    }
    const found = eList.some((e) => e.id === EMPLOYMENT_ID);
    console.log(
      found
        ? `\n    The employment IS in this token's list.`
        : `\n    !! The employment is NOT in this token's list (${eList.length} returned).`,
    );
  }

  const one = await get(`/v1/employments/${EMPLOYMENT_ID}`, token);
  console.log(
    `\n  GET /v1/employments/{id} -> ${one.status}${one.json?.message ? `  "${one.json.message}"` : ''}`,
  );
  console.log('');
}

console.log(`Reading this:
  If the customer token lists 0 employments, or lists some but not this one,
  then "Company not found" is a misleading message for an out-of-scope
  employment, and the finding is about the error text plus whatever governs
  that scope.
  If it lists this employment AND still 404s on fetching it, that is a
  straightforward bug.
`);
