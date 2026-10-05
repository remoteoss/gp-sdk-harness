#!/usr/bin/env node
/**
 * Create a GP employment and complete the employee steps through the API —
 * no SDK, no browser.
 *
 * Why this exists: `bank-tests.mjs` only needs `dotenv` and `jsonwebtoken`,
 * both of which pass a minimum-package-age policy. A recent SDK release does
 * not. So the partner bank-details questions can be answered while
 * `@remoteoss/remote-flows` is unavailable — this script produces the
 * employment the matrix needs. The browser flows still have to run through the
 * real SDK later, because finding SDK bugs is a separate goal that this
 * script deliberately does not serve.
 *
 * The step payloads are country-specific and JSON-schema driven, so this
 * script does NOT invent them. It fetches each step's schema, tells you which
 * fields are required, and sends a payload you supply in
 * `fixtures/seed-<CC>.json`. Run --plan first; it writes a template.
 *
 *   node scripts/seed-employment.mjs --plan --country GBR
 *   node scripts/seed-employment.mjs --country GBR
 *   node scripts/seed-employment.mjs --country GBR --resume <employmentId>
 *
 * Flags:
 *   --plan              fetch every schema, print required fields, write a
 *                       payload template, change nothing
 *   --country <CC>      ISO alpha-3, e.g. GBR
 *   --resume <id>       continue an employment that already exists
 *   --stop-after <step> one of: create, basic, contract, admin, invite,
 *                       personal, address, bank
 *   --legal-entity <id> override the legal entity instead of taking the first
 *                       GP-enabled one
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  GATEWAY,
  GATEWAY_NAME,
  PROJECT_ROOT,
  mintAdminToken,
  mintEmployeeToken,
  requireEnv,
} from '../server/token.js';

/* ------------------------------------------------------------------ *
 * Args
 * ------------------------------------------------------------------ */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f) => {
  const i = argv.indexOf(`--${f}`);
  return i === -1 ? undefined : argv[i + 1];
};

const PLAN = has('plan');
const COUNTRY = (val('country') ?? '').toUpperCase();
const RESUME = val('resume');
const STOP_AFTER = val('stop-after');
const LEGAL_ENTITY_OVERRIDE = val('legal-entity');

if (!COUNTRY) {
  console.error(`
✖ --country is required (ISO alpha-3).

  node scripts/seed-employment.mjs --plan --country GBR
`);
  process.exit(1);
}

requireEnv(['REMOTE_OWNER_USER_ID', 'VITE_COMPANY_ID']);
const COMPANY_ID = process.env.VITE_COMPANY_ID;

const SEED_PATH = path.join(PROJECT_ROOT, 'fixtures', `seed-${COUNTRY}.json`);
const SCHEMA_DIR = path.join(PROJECT_ROOT, 'results', 'schemas');

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */
let adminToken;
const employeeTokens = new Map();

async function tokenFor(kind, employmentId) {
  if (kind === 'admin') {
    adminToken ??= (await mintAdminToken()).accessToken;
    return adminToken;
  }
  if (!employeeTokens.has(employmentId)) {
    employeeTokens.set(employmentId, (await mintEmployeeToken(employmentId)).accessToken);
  }
  return employeeTokens.get(employmentId);
}

async function api(method, apiPath, { as = 'admin', employmentId, body } = {}) {
  const token = await tokenFor(as, employmentId);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${GATEWAY}${apiPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON response; `text` is what we report */
  }

  console.log(`  ${method} ${apiPath} -> ${res.status} (${as} token)`);
  return { ok: res.status >= 200 && res.status < 300, status: res.status, text, json };
}

/** Ground rule 5: surface the real error and stop. Never paper over it. */
function halt(what, res) {
  console.error(`
✖ ${what} failed — HTTP ${res.status}

${res.text.slice(0, 1200)}

Stopping. A failed call is a result, not something to retry around. If this is
an auth failure, run scripts/doctor.mjs before changing anything.
`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Schemas
 *
 * Every step's fields vary by country, so the script reads the schema
 * rather than guessing. Guessed payloads produce 422s that look like
 * auth or SDK problems and waste a debugging session.
 * ------------------------------------------------------------------ */
/**
 * Form names, as the SDK actually calls them.
 *
 * The admin-side forms are `global_payroll_`-prefixed. The unprefixed names
 * (`contract_details`, `administrative_details`) also return 200 — they are
 * the EOR forms, with different fields. An earlier version of this script
 * fetched those by mistake and would have built a payload against the wrong
 * schema. Confirmed from a real employer-flow run:
 *   GET /v1/countries/GBR/global_payroll_basic_information  -> 200
 *   GET /v1/countries/GBR/global_payroll_contract_details?employment_id=… -> 200
 * while this script's `basic_information` returned 400.
 */
const STEP_FORMS = {
  basic: 'global_payroll_basic_information',
  contract: 'global_payroll_contract_details',
  admin: 'global_payroll_administrative_details',
  personal: 'global_payroll_personal_details',
  address: 'address_details',
  bank: 'global_payroll_bank_account_details',
};

/** Forms the SDK requests with ?employment_id= once an employment exists. */
const NEEDS_EMPLOYMENT_ID = new Set(['contract', 'admin', 'personal', 'address', 'bank']);

function requiredFieldsOf(schema) {
  const root = schema?.data?.schema ?? schema?.data ?? schema;
  const required = root?.required ?? [];
  const props = root?.properties ?? {};
  return required.map((name) => {
    const p = props[name] ?? {};
    return {
      name,
      type: p.type ?? '?',
      title: p.title ?? '',
      enum: Array.isArray(p.oneOf)
        ? p.oneOf.map((o) => o.const ?? o.value).filter(Boolean)
        : p.enum,
    };
  });
}

async function fetchSchema(step, { employmentId } = {}) {
  const form = STEP_FORMS[step];
  const query =
    employmentId && NEEDS_EMPLOYMENT_ID.has(step) ? `?employment_id=${employmentId}` : '';
  const res = await api('GET', `/v1/countries/${COUNTRY}/${form}${query}`);
  if (!res.ok) return { form, error: res };

  fs.mkdirSync(SCHEMA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SCHEMA_DIR, `${COUNTRY}-${form}.json`),
    `${JSON.stringify(res.json, null, 2)}\n`,
  );
  return { form, schema: res.json, required: requiredFieldsOf(res.json) };
}

/* ------------------------------------------------------------------ *
 * --plan
 * ------------------------------------------------------------------ */
async function plan() {
  console.log(`\nPlanning a ${COUNTRY} employment on ${GATEWAY_NAME}`);
  console.log(`  company ${COMPANY_ID}\n`);

  const entities = await api('GET', `/v1/companies/${COMPANY_ID}/legal-entities`);
  if (!entities.ok) halt('GET legal-entities', entities);

  const list =
    entities.json?.data?.company_legal_entities ??
    entities.json?.data?.legal_entities ??
    entities.json?.data ??
    [];
  console.log(`\n  ${list.length} legal entit${list.length === 1 ? 'y' : 'ies'} on this company:`);
  for (const e of list) {
    console.log(
      `    ${e.id ?? e.slug}  country=${e.country?.code ?? e.country_code ?? '?'}  ` +
        `GP=${e.global_payroll_enabled === true ? 'yes' : 'NO'}` +
        `${e.is_default ? '  (default)' : ''}  name=${e.legal_name ?? e.name ?? '?'}`,
    );
  }
  const gp = list.filter((e) => e.global_payroll_enabled === true);
  console.log(
    `\n  ${gp.length} GP-enabled: ${gp.map((e) => e.country?.code ?? e.country_code).join(', ') || 'none'}` +
      `\n  Only a GP-enabled entity can carry a global_payroll employment. Note that the` +
      `\n  default entity is not necessarily the GP-enabled one. Full response saved to` +
      `\n  results/schemas/legal-entities.json.\n`,
  );
  fs.mkdirSync(SCHEMA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SCHEMA_DIR, 'legal-entities.json'),
    `${JSON.stringify(entities.json, null, 2)}\n`,
  );

  if (!RESUME) {
    console.log(
      `\n  Note: several of these forms take ?employment_id= and can answer\n` +
        `  differently once an employment exists. For the schemas the real flow\n` +
        `  sees, re-run --plan with --resume <employmentId>.`,
    );
  }

  const template = {};
  for (const step of Object.keys(STEP_FORMS)) {
    console.log(`\n── ${step} (${STEP_FORMS[step]})`);
    const r = await fetchSchema(step, { employmentId: RESUME });
    if (r.error) {
      console.log(`   could not fetch: HTTP ${r.error.status} ${r.error.text.slice(0, 200)}`);
      console.log(
        `   If this is a 400, check the form name. The GP forms are\n` +
          `   'global_payroll_'-prefixed; the unprefixed ones are the EOR variants and\n` +
          `   return a different schema rather than an error, which is easy to miss.`,
      );
      template[step] = {};
      continue;
    }
    if (!r.required.length) {
      console.log('   no required fields reported');
      template[step] = {};
      continue;
    }
    for (const f of r.required) {
      const opts = f.enum?.length ? `  one of: ${f.enum.slice(0, 8).join(', ')}` : '';
      console.log(`   ${f.name}  (${f.type})${f.title ? `  — ${f.title}` : ''}${opts}`);
    }
    template[step] = Object.fromEntries(r.required.map((f) => [f.name, null]));
  }

  if (fs.existsSync(SEED_PATH)) {
    console.log(`\n${path.relative(PROJECT_ROOT, SEED_PATH)} already exists — not overwriting.`);
    console.log('Compare it against the required fields above.');
  } else {
    fs.mkdirSync(path.dirname(SEED_PATH), { recursive: true });
    fs.writeFileSync(SEED_PATH, `${JSON.stringify(template, null, 2)}\n`);
    console.log(`\nWrote a template to ${path.relative(PROJECT_ROOT, SEED_PATH)}`);
  }

  console.log(`
Fill the nulls with sandbox test data, then run:
  node scripts/seed-employment.mjs --country ${COUNTRY}
`);
}

/* ------------------------------------------------------------------ *
 * Seed
 * ------------------------------------------------------------------ */
const ORDER = ['create', 'basic', 'contract', 'admin', 'invite', 'personal', 'address', 'bank'];

function loadSeed() {
  if (!fs.existsSync(SEED_PATH)) {
    console.error(`
✖ No ${path.relative(PROJECT_ROOT, SEED_PATH)}

  Run the planner first — it fetches the real schemas and writes a template:
    node scripts/seed-employment.mjs --plan --country ${COUNTRY}
`);
    process.exit(1);
  }
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const unfilled = [];
  for (const [step, payload] of Object.entries(seed)) {
    for (const [k, v] of Object.entries(payload ?? {})) {
      if (v === null) unfilled.push(`${step}.${k}`);
    }
  }
  if (unfilled.length) {
    console.error(`
✖ ${path.relative(PROJECT_ROOT, SEED_PATH)} still has unfilled fields:

  ${unfilled.join('\n  ')}

  Fill them with sandbox test data. This script will not invent values —
  a guessed payload produces 422s that look like auth or SDK failures.
`);
    process.exit(1);
  }
  return seed;
}

async function seed() {
  const data = loadSeed();
  const stopIndex = STOP_AFTER ? ORDER.indexOf(STOP_AFTER) : ORDER.length - 1;
  if (STOP_AFTER && stopIndex === -1) {
    console.error(`✖ --stop-after must be one of: ${ORDER.join(', ')}`);
    process.exit(1);
  }
  const shouldRun = (step) => ORDER.indexOf(step) <= stopIndex;

  console.log(`\nSeeding a ${COUNTRY} employment on ${GATEWAY_NAME}`);
  console.log(`  company ${COMPANY_ID}`);
  console.log(`  stopping after ${ORDER[stopIndex]}\n`);

  let employmentId = RESUME;

  /* create ------------------------------------------------------- */
  if (!employmentId && shouldRun('create')) {
    let legalEntityId = LEGAL_ENTITY_OVERRIDE;
    if (!legalEntityId) {
      const entities = await api('GET', `/v1/companies/${COMPANY_ID}/legal-entities`);
      if (!entities.ok) halt('GET legal-entities', entities);
      const list =
        entities.json?.data?.company_legal_entities ??
        entities.json?.data?.legal_entities ??
        entities.json?.data ??
        [];
      // Match on country AND global_payroll_enabled. The company's default
      // entity is not necessarily the GP-enabled one — on the GP SDK Harness
      // company the default is the CAN entity, which has GP off.
      const inCountry = list.filter((e) => (e.country?.code ?? e.country_code) === COUNTRY);
      const match = inCountry.find((e) => e.global_payroll_enabled === true);

      if (!match) {
        const why = inCountry.length
          ? `${inCountry.length} ${COUNTRY} entit${inCountry.length === 1 ? 'y exists' : 'ies exist'} but none has global_payroll_enabled`
          : `no legal entity for ${COUNTRY} at all`;
        console.error(`
✖ No GP-enabled legal entity for ${COUNTRY} on company ${COMPANY_ID} — ${why}.

  Entities present:
${
  list
    .map(
      (e) =>
        `    ${e.id ?? e.slug}  ${e.country?.code ?? e.country_code ?? '?'}  ` +
        `GP=${e.global_payroll_enabled === true ? 'yes' : 'NO'}  ${e.legal_name ?? e.name ?? ''}`,
    )
    .join('\n') || '    none'
}

  Stop here. Do not create or enable a legal entity —
  the sandbox helper endpoints that do change shared data.
`);
        process.exit(1);
      }
      legalEntityId = match.id ?? match.slug;
      console.log(
        `  using legal entity ${legalEntityId} — ${COUNTRY}, global_payroll_enabled`,
      );
    }

    const res = await api('POST', '/v1/employments', {
      body: {
        ...data.create,
        country_code: COUNTRY,
        legal_entity_id: legalEntityId,
        type: 'global_payroll',
      },
    });
    if (!res.ok) halt('POST /v1/employments', res);
    employmentId = res.json?.data?.employment?.id ?? res.json?.data?.id;
    if (!employmentId) halt('POST /v1/employments returned no employment id', res);
    console.log(`\n  employment ${employmentId}\n`);
  }

  if (!employmentId) {
    console.error('✖ No employment ID. Pass --resume <id> or let the create step run.');
    process.exit(1);
  }

  /* admin-side steps --------------------------------------------- */
  const adminSteps = [
    ['basic', 'PUT', `/v2/employments/${employmentId}/basic-information`],
    ['contract', 'PUT', `/v2/employments/${employmentId}/contract-details`],
    ['admin', 'PUT', `/v2/employments/${employmentId}/administrative-details`],
  ];
  for (const [step, method, apiPath] of adminSteps) {
    if (!shouldRun(step)) break;
    const res = await api(method, apiPath, { body: data[step] });
    if (!res.ok) halt(`${method} ${apiPath}`, res);
  }

  if (shouldRun('invite')) {
    const steps = await api('GET', `/v1/employments/${employmentId}/onboarding-steps`);
    if (steps.ok) {
      fs.mkdirSync(SCHEMA_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(SCHEMA_DIR, `onboarding-steps-${employmentId}.json`),
        `${JSON.stringify(steps.json, null, 2)}\n`,
      );
    }
    const res = await api('POST', `/v1/employments/${employmentId}/invite`);
    if (!res.ok) halt(`POST /v1/employments/${employmentId}/invite`, res);
  }

  /* employee-side steps ------------------------------------------ */
  const employeeSteps = [
    ['personal', '/v1/employee/personal-details'],
    ['address', '/v1/employee/address'],
    ['bank', '/v1/employee/bank-account'],
  ];
  for (const [step, apiPath] of employeeSteps) {
    if (!shouldRun(step)) break;
    const body =
      step === 'bank' ? { bank_account_details: data.bank } : data[step];
    const res = await api('PUT', apiPath, { as: 'employee', employmentId, body });
    if (!res.ok) halt(`PUT ${apiPath}`, res);
  }

  /* sub-steps, for the record ------------------------------------ */
  const finalSteps = await api('GET', `/v1/employments/${employmentId}/onboarding-steps`);
  if (finalSteps.ok) {
    const raw = JSON.stringify(finalSteps.json);
    console.log(
      `\n  employee_provides_bank_details sub-step present: ` +
        `${raw.includes('employee_provides_bank_details')}`,
    );
  }

  console.log(`
Done. Employment ${employmentId}

Next:
  EMPLOYMENT_ID=${employmentId} COUNTRY_CODE=${COUNTRY} npm run fixture
  EMPLOYMENT_ID=${employmentId} COUNTRY_CODE=${COUNTRY} npm run test:bank

This is the dedicated test employment. T8 activation is irreversible and needs
both opt-ins to agree — confirm the ID before running it.
`);
}

await (PLAN ? plan() : seed());
