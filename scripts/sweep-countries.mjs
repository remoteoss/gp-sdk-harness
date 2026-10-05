#!/usr/bin/env node
/**
 * Sweep the GP form schemas for two structural problems, across every country
 * the sandbox exposes.
 *
 *   node scripts/sweep-countries.mjs
 *   COUNTRIES=GBR,USA,DEU,ESP,PRT,CAN node scripts/sweep-countries.mjs
 *
 * Both checks exist because "this is broken on GBR" and "this is broken in
 * thirty countries" are very different statements, and both are answerable by
 * reading schemas rather than walking a flow in each country.
 *
 * CHECK 1 — a required field the flow will not send.
 * `global_payroll_personal_details` lists `name` in `required` in most
 * countries. Where the SDK strips that field before sending, the headless form
 * blocks the submit on a field it will never submit, and the step cannot be
 * completed. The detectable test is simply: is `name` required?
 *
 * CHECK 2 — a hidden field required only by a rule that can never fire.
 * A field presented as `inputType: hidden` draws no input, so a conforming
 * renderer never collects it. If the same field appears in the `then.required`
 * of an `allOf` block gated on `"if": false`, the schema says three different
 * ways that the field is optional — and a validator that requires it anyway
 * makes the step unpassable with no way to supply the value.
 *
 * Caveat worth keeping: check 2's signature is necessary but not sufficient.
 * The trap only bites if the VALIDATOR also requires the field, which a schema
 * read cannot tell you — the same dead-rule pattern appears on forms that pass
 * fine. Treat a hit as "worth a live attempt", not proven. Check 1 is exact.
 *
 * Read-only: GETs of public form schemas. Nothing is written, no employment is
 * touched. Zero dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';

import { GATEWAY, GATEWAY_NAME, PROJECT_ROOT, mintAdminToken } from '../server/token.js';

const EMPLOYMENT_ID = process.env.EMPLOYMENT_ID; // optional; some forms branch on it

const { accessToken } = await mintAdminToken();

async function get(apiPath) {
  const res = await fetch(`${GATEWAY}${apiPath}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null };
  }
}

/* Which countries to look at. */
let countries;
if (process.env.COUNTRIES) {
  countries = process.env.COUNTRIES.split(',').map((c) => c.trim().toUpperCase());
} else {
  const res = await get('/v1/countries');
  const list = res.json?.data?.countries ?? res.json?.data ?? [];
  countries = list
    .map((c) => c.code ?? c.alpha_2_code ?? c.alpha_3_code)
    .filter((c) => typeof c === 'string' && c.length === 3);
  if (!countries.length) {
    console.error('\n✖ Could not enumerate countries. Pass COUNTRIES=GBR,USA,… instead.\n');
    process.exit(1);
  }
}

const root = (d) => d?.data?.schema ?? d?.data ?? d;

/** Fields the schema tells a renderer to hide. */
function hiddenFields(schema) {
  const props = schema?.properties ?? {};
  return Object.keys(props).filter(
    (k) => (props[k]?.['x-jsf-presentation'] ?? {}).inputType === 'hidden',
  );
}

/** Fields required only by a rule that can never match. */
function deadRequired(schema) {
  const out = [];
  for (const blk of schema?.allOf ?? []) {
    if (blk?.if === false) out.push(...(blk?.then?.required ?? []));
  }
  return out;
}

console.log(`\nSweeping ${countries.length} countries on ${GATEWAY_NAME}`);
console.log(`  check 1: is \`name\` required on global_payroll_personal_details?`);
console.log(`  check 2: any field BOTH hidden AND required only by an "if": false rule?\n`);

const q = EMPLOYMENT_ID ? `?employment_id=${EMPLOYMENT_ID}` : '';
const rows = [];

for (const cc of countries) {
  const row = { country: cc };

  const personal = await get(`/v1/countries/${cc}/global_payroll_personal_details${q}`);
  if (personal.status !== 200) {
    row.f1 = `schema ${personal.status}`;
  } else {
    const s = root(personal.json);
    row.f1 = (s?.required ?? []).includes('name') ? 'AFFECTED' : 'ok';
    row.f1Detail = `required: ${(s?.required ?? []).join(', ') || 'none'}`;
  }

  const contract = await get(`/v1/countries/${cc}/global_payroll_contract_details${q}`);
  if (contract.status !== 200) {
    row.f2 = `schema ${contract.status}`;
  } else {
    const s = root(contract.json);
    const hidden = new Set(hiddenFields(s));
    const dead = deadRequired(s);
    const trap = dead.filter((f) => hidden.has(f));
    row.f2 = trap.length ? `AFFECTED (${trap.join(', ')})` : 'ok';
    row.f2Detail = `hidden: ${[...hidden].join(', ') || 'none'} | dead-required: ${dead.join(', ') || 'none'}`;
  }

  rows.push(row);
  const mark = (v) => (String(v).startsWith('AFFECTED') ? '✖' : String(v).startsWith('schema') ? '?' : '✓');
  console.log(`  ${cc}   f1 ${mark(row.f1)} ${String(row.f1).padEnd(28)} f2 ${mark(row.f2)} ${row.f2}`);
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */
const f1 = rows.filter((r) => r.f1 === 'AFFECTED').map((r) => r.country);
const f2 = rows.filter((r) => String(r.f2).startsWith('AFFECTED')).map((r) => r.country);
const noSchema = rows.filter((r) => String(r.f1).startsWith('schema') && String(r.f2).startsWith('schema')).map((r) => r.country);

console.log(`\n${'─'.repeat(66)}`);
console.log(`Check 1 (name required, so a strip would block the step):`);
console.log(`  ${f1.length}/${rows.length} affected${f1.length ? ': ' + f1.join(', ') : ''}`);
console.log(`\nCheck 2 (hidden field required only by a dead rule):`);
console.log(`  ${f2.length}/${rows.length} affected${f2.length ? ': ' + f2.join(', ') : ''}`);
if (noSchema.length) {
  console.log(`\nNo GP schemas at all (presumably not GP-enabled): ${noSchema.length} — ${noSchema.join(', ')}`);
}

console.log(`
Caveat worth keeping: check 2's signature is necessary but not sufficient.
The trap only bites if the VALIDATOR also requires the field, which a schema
read cannot tell us — the same dead-rule
pattern appears on forms that pass fine. So treat an f2 hit as "very likely broken,
worth a live attempt", not proven. Check 1's test is exact.
`);

const outDir = path.join(PROJECT_ROOT, 'results');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `country-sweep-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(out, `${JSON.stringify({ ranAt: new Date().toISOString(), rows }, null, 2)}\n`);
console.log(`Wrote results/${path.basename(out)}\n`);
