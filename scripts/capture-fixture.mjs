#!/usr/bin/env node
/**
 * Capture the bank payload that the employee flow just saved, so the bank
 * matrix has something real to send.
 *
 *   EMPLOYMENT_ID=<id> npm run fixture
 *   EMPLOYMENT_ID=<id> COUNTRY_CODE=GBR npm run fixture
 *
 * GET /v1/employee/bank-account answers with an EmploymentDetailsOnlyResponse,
 * in which `data.employment.bank_account_details` is an ARRAY — even though the
 * PUT body takes a single OBJECT under the same key. That asymmetry is itself
 * part of the answer to the split-payments question, so the script records the
 * whole response alongside the reshaped fixture.
 */
import fs from 'node:fs';
import path from 'node:path';

import { GATEWAY, PROJECT_ROOT, mintEmployeeToken } from '../server/token.js';

const employmentId = process.env.EMPLOYMENT_ID;
if (!employmentId) {
  console.error('\n✖ EMPLOYMENT_ID is required.\n  EMPLOYMENT_ID=<id> npm run fixture\n');
  process.exit(1);
}

const { accessToken } = await mintEmployeeToken(employmentId);

const res = await fetch(`${GATEWAY}/v1/employee/bank-account`, {
  headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
});
const text = await res.text();

if (!res.ok) {
  console.error(`\n✖ GET /v1/employee/bank-account -> HTTP ${res.status}\n${text}\n`);
  process.exit(1);
}

const body = JSON.parse(text);
const accounts = body?.data?.employment?.bank_account_details;

if (!Array.isArray(accounts) || accounts.length === 0) {
  console.error(
    `\n✖ No bank_account_details on the response. Complete the bank step in the\n` +
      `  employee flow first, then re-run. Raw response:\n\n${text.slice(0, 800)}\n`,
  );
  process.exit(1);
}

if (accounts.length > 1) {
  console.warn(
    `\n! ${accounts.length} bank accounts came back. The PUT body only carries one\n` +
      `  object, so this is directly relevant to the split-payments question.\n` +
      `  Using the first one for the fixture; all of them are in the .raw.json file.\n`,
  );
}

const countryCode =
  process.env.COUNTRY_CODE?.toUpperCase() ??
  body?.data?.employment?.country?.code ??
  'UNKNOWN';

/**
 * Reshape the read model into something the PUT will accept.
 *
 * The two shapes are not the same, which an earlier version of this script
 * assumed. Observed on GBR, 2026-09-30:
 *
 *   GET returns  [{ is_default: true,
 *                   local_details:        { account_holder, account_number, ownership_type, sort_code },
 *                   international_details:{ account_holder, account_number, iban, ownership_type } }]
 *
 *   PUT accepts  { bank_account_details: { label_name, account_holder,
 *                                          account_number, ownership_type, sort_code } }
 *
 * So: unwrap the array, flatten the country-appropriate sub-object, drop
 * `is_default` (not a write field), and restore `label_name`, which the PUT
 * requires and the GET does not return at all.
 */
function toPutShape(account) {
  const notes = [];
  let fields;

  if (account.local_details || account.international_details) {
    // local_details carries the domestic identifiers the country form asks for
    // (sort_code here). Prefer it; do not merge, since the two sets disagree.
    const source = account.local_details ? 'local_details' : 'international_details';
    fields = { ...account[source] };
    notes.push(`flattened ${source}`);
    const dropped = Object.keys(account).filter(
      (k) => k !== source && k !== 'local_details' && k !== 'international_details',
    );
    const other = account.local_details && account.international_details
      ? ` and ignored international_details (${Object.keys(account.international_details).join(', ')})`
      : '';
    if (dropped.length) notes.push(`dropped ${dropped.join(', ')}${other}`);
    else if (other) notes.push(other.replace(/^ and /, ''));
  } else {
    const { is_default: _isDefault, ...rest } = account;
    fields = rest;
    notes.push('response was already flat');
  }

  if (!fields.label_name) {
    fields.label_name = process.env.LABEL_NAME ?? 'Primary';
    notes.push(
      `added label_name="${fields.label_name}" — required by the PUT, never returned by the GET` +
        (process.env.LABEL_NAME ? '' : ' (set LABEL_NAME to override)'),
    );
  }

  return { fields, notes };
}

const { fields: putFields, notes } = toPutShape(accounts[0]);
const fixture = { bank_account_details: putFields };

const dir = path.join(PROJECT_ROOT, 'fixtures');
fs.mkdirSync(dir, { recursive: true });

const fixturePath = path.join(dir, `bank-${countryCode}.json`);
const rawPath = path.join(dir, `bank-${countryCode}.raw.json`);

fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
fs.writeFileSync(rawPath, `${JSON.stringify(body, null, 2)}\n`);

console.log(`\nWrote ${path.relative(PROJECT_ROOT, fixturePath)}`);
console.log(`Wrote ${path.relative(PROJECT_ROOT, rawPath)} (full response, ${accounts.length} account(s))`);

console.log(`\nThe read and write shapes differ, so the fixture was reshaped:`);
for (const n of notes) console.log(`  · ${n}`);
console.log(`\nFields in the fixture: ${Object.keys(putFields).join(', ')}`);
if (accounts[0].is_default !== undefined) {
  console.log(
    `\nNote: the account carries is_default=${accounts[0].is_default}. A default\n` +
      `flag only has meaning where more than one account can exist, yet the PUT accepts\n` +
      `exactly one object.`,
  );
}
console.log(`\nNext: EMPLOYMENT_ID=${employmentId} COUNTRY_CODE=${countryCode} npm run test:bank\n`);
