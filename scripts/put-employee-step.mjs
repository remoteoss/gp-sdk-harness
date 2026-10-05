#!/usr/bin/env node
/**
 * Submit one employee onboarding step straight to the gateway.
 *
 *   EMPLOYMENT_ID=<id> node scripts/put-employee-step.mjs personal '{"given_name":"Alex", ...}'
 *   EMPLOYMENT_ID=<id> node scripts/put-employee-step.mjs address ./payload.json
 *
 * For when the SDK cannot submit a step but the API will accept it — for
 * example when a schema marks a field required that the flow never renders.
 *
 * Envelopes and the x-rf-employment-id header match the SDK exactly, taken
 * from src/flows/PayrollEmployeeOnboarding/api.ts:
 *   personal -> { personal_details: {...} }
 *   address  -> { address_details: {...} }
 *   bank     -> { bank_account_details: {...} }
 *
 * Zero dependencies, so this works with an empty node_modules.
 */
import fs from 'node:fs';

import { GATEWAY, GATEWAY_NAME, mintEmployeeToken } from '../server/token.js';

const STEPS = {
  personal: { path: '/v1/employee/personal-details', envelope: 'personal_details' },
  address: { path: '/v1/employee/address', envelope: 'address_details' },
  bank: { path: '/v1/employee/bank-account', envelope: 'bank_account_details' },
};

/**
 * The SDK strips `name` from the personal-details payload, on the stated
 * grounds that the endpoint rejects it:
 *
 *   // 'name' is a computed read-only display field in the schema
 *   // (additionalProperties: false on the PUT endpoint rejects it).
 *   // Strip it before sending.
 *
 * Tested 2026-09-30 against the partners gateway: sending WITHOUT `name`
 * returns 422 `name: ["can't be blank"]`. The endpoint requires it. So the
 * comment is wrong or out of date, and stripping is not the default here.
 *
 * Set STRIP_NAME=true to reproduce the SDK's behaviour exactly.
 */
const STRIP = {
  personal: process.env.STRIP_NAME === 'true' ? ['name'] : [],
};

const [step, payloadArg] = process.argv.slice(2);
const employmentId = process.env.EMPLOYMENT_ID;

if (!employmentId || !step || !STEPS[step] || !payloadArg) {
  console.error(`
Usage:
  EMPLOYMENT_ID=<id> node scripts/put-employee-step.mjs <step> <json|file>

  step: ${Object.keys(STEPS).join(' | ')}
`);
  process.exit(1);
}

let fields;
try {
  const raw = fs.existsSync(payloadArg) ? fs.readFileSync(payloadArg, 'utf8') : payloadArg;
  fields = JSON.parse(raw);
} catch (err) {
  console.error(`\n✖ Could not parse the payload: ${err.message}\n`);
  process.exit(1);
}

// If the caller passed an already-enveloped object, unwrap it.
const { envelope, path: apiPath } = STEPS[step];
if (Object.keys(fields).length === 1 && fields[envelope] && typeof fields[envelope] === 'object') {
  fields = fields[envelope];
}

const stripped = [];
for (const key of STRIP[step] ?? []) {
  if (key in fields) {
    delete fields[key];
    stripped.push(key);
  }
}

const { accessToken } = await mintEmployeeToken(employmentId);

console.log(`\nPUT ${apiPath} on ${GATEWAY_NAME}`);
console.log(`  employment ${employmentId}`);
console.log(`  envelope   ${envelope}`);
if (stripped.length) {
  console.log(
    `  stripped   ${stripped.join(', ')} — STRIP_NAME=true, reproducing the SDK's behaviour`,
  );
}
console.log(`  fields     ${Object.keys(fields).join(', ')}\n`);

const res = await fetch(`${GATEWAY}${apiPath}`, {
  method: 'PUT',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    // The SDK sends this too. Harmless direct to the gateway, which reads the
    // identity from the token, but kept so the request matches the real one.
    'x-rf-employment-id': employmentId,
  },
  body: JSON.stringify({ [envelope]: fields }),
});

const text = await res.text();
console.log(`HTTP ${res.status}\n`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2).slice(0, 2000));
} catch {
  console.log(text.slice(0, 2000));
}
console.log('');
process.exit(res.ok ? 0 : 1);
