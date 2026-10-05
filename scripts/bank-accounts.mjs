#!/usr/bin/env node
/**
 * Snapshot the employee's bank accounts, and diff against the last snapshot.
 *
 *   EMPLOYMENT_ID=<id> node scripts/bank-accounts.mjs "before second account"
 *   EMPLOYMENT_ID=<id> node scripts/bank-accounts.mjs "after second account"
 *   EMPLOYMENT_ID=<id> node scripts/bank-accounts.mjs "after api put"
 *
 * Built for the multiple-account case, which looked untestable. Split payments are
 * EOR-only, but MULTIPLE bank accounts are supported for Global Payroll
 * (Martyna Bors, #engineering-help, 2026-02-24). So the real question —
 * does a single-object PUT destroy the employee's other accounts? — can be
 * tested by adding a second account in the Remote dashboard and then writing
 * one through the API.
 *
 * Every snapshot is appended to results/bank-accounts-timeline.jsonl so the
 * sequence is evidence rather than recollection.
 *
 * Read-only. Zero dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';

import { GATEWAY, GATEWAY_NAME, PROJECT_ROOT, mintAdminToken, mintEmployeeToken } from '../server/token.js';

const EMPLOYMENT_ID = process.env.EMPLOYMENT_ID;
const LABEL = process.argv.slice(2).join(' ') || 'unlabelled';

if (!EMPLOYMENT_ID) {
  console.error('\n✖ EMPLOYMENT_ID is required.\n  EMPLOYMENT_ID=<id> node scripts/bank-accounts.mjs "<label>"\n');
  process.exit(1);
}

const TIMELINE = path.join(PROJECT_ROOT, 'results', 'bank-accounts-timeline.jsonl');

async function get(apiPath, token) {
  const res = await fetch(`${GATEWAY}${apiPath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text };
  }
}

/** One-line identity for an account, so two snapshots can be compared by eye. */
function describe(acct) {
  const local = acct.local_details ?? {};
  const intl = acct.international_details ?? {};
  const flat = { ...intl, ...local };
  return {
    is_default: acct.is_default,
    account_holder: flat.account_holder,
    account_number: flat.account_number,
    sort_code: flat.sort_code,
    iban: flat.iban,
    ownership_type: flat.ownership_type,
    // label_name is required on write and never returned by the GET
    keys: Object.keys(acct).sort().join(','),
  };
}

const { accessToken: employeeToken } = await mintEmployeeToken(EMPLOYMENT_ID);
const bank = await get('/v1/employee/bank-account', employeeToken);

if (bank.status !== 200) {
  console.error(`\n✖ GET /v1/employee/bank-account -> ${bank.status}\n${bank.text ?? JSON.stringify(bank.json)}\n`);
  process.exit(1);
}

const accounts = bank.json?.data?.employment?.bank_account_details ?? [];
const snapshot = {
  ts: new Date().toISOString(),
  label: LABEL,
  employmentId: EMPLOYMENT_ID,
  count: Array.isArray(accounts) ? accounts.length : accounts ? 1 : 0,
  accounts: (Array.isArray(accounts) ? accounts : [accounts]).filter(Boolean).map(describe),
};

console.log(`\nBank accounts on ${GATEWAY_NAME} — "${LABEL}"`);
console.log(`  employment ${EMPLOYMENT_ID}`);
console.log(`  count      ${snapshot.count}\n`);

snapshot.accounts.forEach((a, i) => {
  console.log(`  [${i}] is_default=${a.is_default}`);
  console.log(`      holder  ${a.account_holder ?? '—'}`);
  console.log(`      number  ${a.account_number ?? '—'}   sort ${a.sort_code ?? '—'}`);
  console.log(`      iban    ${a.iban ?? '—'}`);
  console.log(`      keys    ${a.keys}`);
});

/* Compare with the previous snapshot for this employment. */
let previous = null;
if (fs.existsSync(TIMELINE)) {
  const rows = fs
    .readFileSync(TIMELINE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.employmentId === EMPLOYMENT_ID);
  previous = rows[rows.length - 1] ?? null;
}

if (previous) {
  console.log(`\n  vs previous snapshot "${previous.label}" (${previous.ts.slice(11, 19)}): ` +
    `${previous.count} -> ${snapshot.count}`);
  if (snapshot.count < previous.count) {
    console.log(
      `  *** ACCOUNTS LOST: ${previous.count - snapshot.count}. If the only thing between\n` +
        `      these two snapshots was a PUT of one account, that PUT is destructive.`,
    );
  } else if (snapshot.count > previous.count) {
    console.log(`  accounts gained: ${snapshot.count - previous.count}`);
  } else {
    console.log(`  count unchanged`);
  }
  const defaults = snapshot.accounts.filter((a) => a.is_default === true).length;
  if (snapshot.count > 1) {
    console.log(
      `  is_default true on ${defaults} of ${snapshot.count} accounts` +
        (defaults === snapshot.count
          ? '  <-- true on ALL of them, which cannot be right for a routing flag'
          : ''),
    );
  }
}

fs.mkdirSync(path.dirname(TIMELINE), { recursive: true });
fs.appendFileSync(TIMELINE, `${JSON.stringify(snapshot)}\n`);
console.log(`\n  appended to results/${path.basename(TIMELINE)}`);

/* Who to sign in as, for the manual step. */
const { accessToken: adminToken } = await mintAdminToken();
const emp = await get(`/v1/employments/${EMPLOYMENT_ID}`, adminToken);
const e = emp.json?.data?.employment ?? {};
console.log(
  `\n  employee: ${e.personal_email ?? e.user_email ?? '(email not in response)'}` +
    `   status=${e.status ?? '?'}  user_status=${e.user_status ?? '?'}\n`,
);
