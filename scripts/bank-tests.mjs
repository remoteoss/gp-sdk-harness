#!/usr/bin/env node
/**
 * The bank-account test matrix.
 *
 *   EMPLOYMENT_ID=<id> COUNTRY_CODE=GBR npm run test:bank
 *
 * Talks to the gateway directly — no browser, no proxy, no SDK. Each row
 * states which token it uses on purpose, because the open questions are about
 * tokens.
 *
 * Rules, from the implementation spec:
 *  - Never retry automatically. A failed test is a result.
 *  - T8 (activation) is irreversible, so it needs two explicit opt-ins.
 *  - Only ever run against the dedicated test employment.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  GATEWAY,
  GATEWAY_NAME,
  PROJECT_ROOT,
  mintAdminToken,
  mintEmployeeToken,
} from '../server/token.js';

const EMPLOYMENT_ID = process.env.EMPLOYMENT_ID;
const COUNTRY_CODE = (process.env.COUNTRY_CODE ?? '').toUpperCase();
const PARTNER_TOKEN = process.env.REMOTE_PARTNER_API_TOKEN;

// T8 flips the employment to active and cannot be undone. Both must be set.
const ALLOW_ACTIVATION =
  process.env.ALLOW_ACTIVATION === 'true' &&
  process.env.ALLOW_ACTIVATION_EMPLOYMENT_ID === EMPLOYMENT_ID;

// T9 needs a split configured by hand in the sandbox UI first.
const SPLIT_CONFIGURED = process.env.SPLIT_CONFIGURED === 'true';

if (!EMPLOYMENT_ID || !COUNTRY_CODE) {
  console.error(`
✖ EMPLOYMENT_ID and COUNTRY_CODE are both required.

  EMPLOYMENT_ID=<uuid> COUNTRY_CODE=GBR npm run test:bank
`);
  process.exit(1);
}

const fixturePath = path.join(PROJECT_ROOT, 'fixtures', `bank-${COUNTRY_CODE}.json`);
if (!fs.existsSync(fixturePath)) {
  console.error(`
✖ No fixture at fixtures/bank-${COUNTRY_CODE}.json

  Complete the bank step in the employee flow, then:
    EMPLOYMENT_ID=${EMPLOYMENT_ID} COUNTRY_CODE=${COUNTRY_CODE} npm run fixture
`);
  process.exit(1);
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const baseDetails = fixture.bank_account_details;
if (!baseDetails || typeof baseDetails !== 'object' || Array.isArray(baseDetails)) {
  console.error(`✖ ${fixturePath} must be { "bank_account_details": { ... } }`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Pick one field to change, so T2 proves a write actually landed.
 * Account numbers and IBANs are left alone — a rejected checksum would
 * look like an auth failure.
 * ------------------------------------------------------------------ */
/**
 * Ordered safest-first, among fields that actually come back on a read.
 *
 * `label_name` is deliberately NOT here despite being the safest field to
 * change: the GET does not return it, so a change to it can
 * never be verified. `account_holder` is free text, is returned inside
 * `local_details`, and has no checksum to fail — unlike the account number
 * and sort code.
 */
const MUTATION_PREFERENCE = [
  'account_holder',
  'account_holder_name',
  'account_name',
  'bank_name',
  'branch_name',
  'label_name', // last resort; unverifiable, and the run will say so
];

/**
 * Flatten the read model so it can be compared with what was written.
 *
 * GET returns `{ is_default, local_details: {...}, international_details: {...} }`
 * while PUT takes flat country fields. Comparing the two directly makes every
 * field look absent — which is what produced a false "whole section replaced"
 * verdict on an earlier run.
 */
function readToFlat(account) {
  if (!account || typeof account !== 'object') return {};
  if (account.local_details || account.international_details) {
    return { ...(account.international_details ?? {}), ...(account.local_details ?? {}) };
  }
  const { is_default: _isDefault, ...rest } = account;
  return rest;
}

/**
 * Pull the account a PUT would have written, already flattened.
 *
 * NOT `accounts[0]`. `PUT /v1/employee/bank-account` targets whichever account
 * carries `is_default`, and array order is not stable — verified 2026-09-30:
 * before a write the default was first in the list, after it was second. An
 * earlier version of this function took index 0 and produced a false FLAG on
 * T2-verify once the employment had two accounts, comparing the write against
 * an account that was never touched.
 *
 * Index 0 is used only as a fallback when nothing is flagged default, which is
 * what happens on an EOR employment with a split configured.
 */
function accountFromResponse(json) {
  const accounts = json?.data?.employment?.bank_account_details;
  const list = Array.isArray(accounts) ? accounts : accounts ? [accounts] : [];
  const target = list.find((a) => a?.is_default === true) ?? list[0];
  return {
    flat: readToFlat(target),
    count: list.length,
    defaultCount: list.filter((a) => a?.is_default === true).length,
    pickedDefault: Boolean(target?.is_default),
  };
}
const NEVER_MUTATE = /iban|account_number|routing|swift|bic|sort_code|bsb|clabe|ifsc|currency|type/i;

function pickMutableField(details) {
  if (process.env.MUTATE_FIELD) return process.env.MUTATE_FIELD;
  for (const name of MUTATION_PREFERENCE) {
    if (typeof details[name] === 'string') return name;
  }
  const fallback = Object.keys(details).find(
    (k) => typeof details[k] === 'string' && !NEVER_MUTATE.test(k),
  );
  return fallback ?? null;
}

const mutateField = pickMutableField(baseDetails);
if (!mutateField) {
  console.error(`
✖ Could not find a safe string field to change in the fixture.
  Fields: ${Object.keys(baseDetails).join(', ')}
  Set MUTATE_FIELD=<name> (and optionally MUTATE_VALUE=<value>) and re-run.
`);
  process.exit(1);
}

const originalValue = baseDetails[mutateField];
const mutatedValue =
  process.env.MUTATE_VALUE ??
  (typeof originalValue === 'string' && originalValue.endsWith(' QA')
    ? originalValue.slice(0, -3)
    : `${originalValue} QA`);

const fullPayload = { bank_account_details: { ...baseDetails, [mutateField]: mutatedValue } };
const partialPayload = { bank_account_details: { [mutateField]: mutatedValue } };

/* ------------------------------------------------------------------ *
 * Request plumbing
 * ------------------------------------------------------------------ */
const results = [];

function preview(text) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
}

async function call({ method, path: apiPath, token, body }) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${GATEWAY}${apiPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, text, json: parsed };
}

/**
 * Run one row. `expected` is prose for the report; `verdict` decides whether
 * the result is a flag. A thrown token exchange is itself a recorded result.
 */
async function run({ id, what, method, apiPath, tokenType, scope, body, expected, answers, verdict, skip }) {
  if (skip) {
    const row = {
      id,
      what,
      call: `${method} ${apiPath}`,
      tokenType,
      scope: scope ?? '—',
      status: null,
      bodyPreview: skip,
      expected,
      answers,
      verdict: 'skipped',
    };
    results.push(row);
    console.log(`${id}  skipped — ${skip}`);
    return row;
  }

  let token;
  // What the gateway actually granted, which is not necessarily what we asked
  // for. Recording only the request would make every scope row an assumption.
  let grantedScope = null;
  try {
    if (tokenType === 'employee') {
      const t = await mintEmployeeToken(EMPLOYMENT_ID, scope, { noCache: true });
      token = t.accessToken;
      grantedScope = t.scope ?? null;
    } else if (tokenType === 'admin') {
      const t = await mintAdminToken(scope, { noCache: true });
      token = t.accessToken;
      grantedScope = t.scope ?? null;
    } else if (tokenType === 'customer-api') {
      token = PARTNER_TOKEN;
      if (!token) throw new Error('REMOTE_PARTNER_API_TOKEN is not set in .env');
      grantedScope = 'n/a — customer API token, not scoped per request';
    }
  } catch (err) {
    // The exchange refusing a scope is a finding about scope enforcement, not
    // a crash. Record it and move on.
    const row = {
      id,
      what,
      call: `${method} ${apiPath}`,
      tokenType,
      scope: scope ?? '—',
      status: 'token exchange failed',
      bodyPreview: preview(err.message),
      expected,
      answers,
      verdict: verdict ? verdict({ status: null, tokenError: err }) : 'record',
    };
    results.push(row);
    console.log(
      `${id}  ${method} ${apiPath} [${tokenType}/${row.scope}] -> token exchange failed  ${row.verdict}\n      ${preview(err.message)}`,
    );
    return row;
  }

  const res = await call({ method, path: apiPath, token, body });

  // A granted scope that differs from the requested one invalidates the row's
  // premise, so say so in the row rather than leaving it to be inferred.
  const scopeMismatch =
    scope && grantedScope && grantedScope !== scope && !grantedScope.startsWith('n/a')
      ? `requested ${scope}, GRANTED ${grantedScope}`
      : null;

  const row = {
    id,
    what,
    call: `${method} ${apiPath}`,
    tokenType,
    scope: scope ?? '—',
    grantedScope,
    scopeMismatch,
    status: res.status,
    bodyPreview: preview(res.text),
    fullResponse: res.json ?? res.text,
    expected,
    answers,
    verdict: verdict ? verdict(res) : 'record',
  };
  results.push(row);
  console.log(`${id}  ${method} ${apiPath} [${tokenType}/${row.scope}] -> ${res.status}  ${row.verdict}`);
  if (scopeMismatch) console.log(`      ! scope ${scopeMismatch} — this row's premise is wrong`);
  return row;
}

const ok = (r) => r.status >= 200 && r.status < 300;

/* ------------------------------------------------------------------ *
 * Preflight: prove the employee token is who we think it is.
 * This is the Sep 17 lesson — a token for the wrong identity makes every
 * row below meaningless.
 * ------------------------------------------------------------------ */
console.log(`\nGP bank-account matrix`);
console.log(`  gateway       ${GATEWAY_NAME} → ${GATEWAY}`);
console.log(`  employment    ${EMPLOYMENT_ID}`);
console.log(`  country       ${COUNTRY_CODE}`);
console.log(`  mutating      ${mutateField}: ${JSON.stringify(originalValue)} → ${JSON.stringify(mutatedValue)}`);
console.log(`  note          verification reads the account flagged is_default, not index 0 —`);
console.log(`                array order is not stable across writes`);
console.log(`  T8 activation ${ALLOW_ACTIVATION ? 'ENABLED' : 'skipped (needs ALLOW_ACTIVATION=true and ALLOW_ACTIVATION_EMPLOYMENT_ID)'}`);
console.log(`  T9 split      ${SPLIT_CONFIGURED ? 'configured' : 'not configured'}\n`);

let employeeToken;
try {
  ({ accessToken: employeeToken } = await mintEmployeeToken(EMPLOYMENT_ID, 'all:write', {
    noCache: true,
  }));
} catch (err) {
  console.error(`\n✖ Could not mint an employee token: ${err.message}\n`);
  process.exit(1);
}

const preflight = await call({
  method: 'GET',
  path: '/v1/employee/current',
  token: employeeToken,
});
const preflightId = preflight.json?.data?.employment?.id ?? preflight.json?.data?.id ?? null;

console.log(`P0  GET /v1/employee/current -> ${preflight.status}  employment=${preflightId ?? '?'}`);

/**
 * `/v1/employee/current` refuses unless the employment is active:
 *   {"message":"The employment is expected to be active in order to perform this action"}
 *
 * Mid-onboarding is exactly the state this matrix needs to test — the internal spec
 * says an employee who is not yet active can submit bank details — so that
 * refusal must not stop the run. Fall back to the bank endpoint itself, which
 * is employee-assertion-only: a 2xx there proves the token is an employee
 * token the gateway accepts for this employment.
 */
const NEEDS_ACTIVE = /expected to be active/i.test(preflight.text);

if (ok(preflight)) {
  if (preflightId && preflightId !== EMPLOYMENT_ID) {
    console.error(`
✖ Preflight failed — the token resolves to a different employment.

  employment in token  ${preflightId}
  expected             ${EMPLOYMENT_ID}

  Every row below depends on this token being the right identity. Running them
  now would produce results that mean nothing. Check REMOTE_OWNER_USER_ID
  against the employment ID — that mix-up caused the Sep 17 confusion.
`);
    process.exit(1);
  }
  console.log('P0  identity confirmed\n');
} else if (NEEDS_ACTIVE) {
  console.log(
    `P0  /v1/employee/current needs an active employment, so it cannot confirm identity\n` +
      `    mid-onboarding. Falling back to GET /v1/employee/bank-account.`,
  );
  const fallback = await call({
    method: 'GET',
    path: '/v1/employee/bank-account',
    token: employeeToken,
  });
  console.log(`P0b GET /v1/employee/bank-account -> ${fallback.status}`);
  if (!ok(fallback)) {
    console.error(`
✖ Preflight failed. Neither identity check succeeded.

  /v1/employee/current      ${preflight.status}  ${preview(preflight.text)}
  /v1/employee/bank-account ${fallback.status}  ${preview(fallback.text)}

  The bank endpoint declares employee-assertion auth only, so a non-2xx here
  means the token is not being accepted as this employee at all. Stop.
`);
    process.exit(1);
  }
  console.log(
    `P0  identity confirmed indirectly — the bank endpoint accepted the token.\n` +
      `    Note that identity was not confirmed via /v1/employee/current.\n`,
  );
} else {
  console.error(`
✖ Preflight failed. Stopping before the matrix runs.

  status    ${preflight.status}
  response  ${preview(preflight.text)}

  Check the aud claim against ${GATEWAY}/auth and the employment ID.
`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * The matrix
 * ------------------------------------------------------------------ */

await run({
  id: 'T1',
  what: 'Read current bank details',
  method: 'GET',
  apiPath: '/v1/employee/bank-account',
  tokenType: 'employee',
  scope: 'all:write',
  expected: '200',
  answers: 'baseline',
  verdict: (r) => (ok(r) ? 'as expected' : 'FLAG'),
});

await run({
  id: 'T2',
  what: `Update as employee — full section, ${mutateField} changed`,
  method: 'PUT',
  apiPath: '/v1/employee/bank-account',
  tokenType: 'employee',
  scope: 'all:write',
  body: fullPayload,
  expected: '2xx, and the T2-verify re-read shows the change',
  answers: 'endpoint + token',
  verdict: (r) => (ok(r) ? 'as expected' : 'FLAG'),
});

// Re-read so "it returned 2xx" and "it actually changed" stay separate claims.
const verify = await run({
  id: 'T2-verify',
  what: 'Re-read after the employee update',
  method: 'GET',
  apiPath: '/v1/employee/bank-account',
  tokenType: 'employee',
  scope: 'all:write',
  expected: `${mutateField} === ${JSON.stringify(mutatedValue)}`,
  answers: 'endpoint + token',
  verdict: (r) => {
    if (!ok(r)) return 'FLAG';
    const { flat, count, pickedDefault } = accountFromResponse(r.json);
    if (count > 1 && !pickedDefault) {
      return `cannot verify — ${count} accounts and none flagged default, so which one the PUT targeted is unknown`;
    }
    if (!(mutateField in flat)) {
      // e.g. label_name: required on write, never returned on read.
      return `cannot verify — the GET does not return ${mutateField}`;
    }
    return flat[mutateField] === mutatedValue
      ? 'as expected'
      : `FLAG — expected ${JSON.stringify(mutatedValue)}, got ${JSON.stringify(flat[mutateField])}`;
  },
});

const accountCountAfterT2 = verify.fullResponse
  ? accountFromResponse(verify.fullResponse).count
  : null;

await run({
  id: 'T3',
  what: 'Update as company owner on the employee endpoint',
  method: 'PUT',
  apiPath: '/v1/employee/bank-account',
  tokenType: 'admin',
  scope: 'all:write',
  body: fullPayload,
  expected: '401 or 403. A 2xx here is a bug',
  answers: 'endpoint + token',
  verdict: (r) => {
    if (r.status === 401 || r.status === 403) return 'as expected';
    if (ok(r)) return 'FLAG — company-owner token wrote to an employee-assertion endpoint';
    return 'record';
  },
});

await run({
  id: 'T4',
  what: 'Bank-only scope',
  method: 'PUT',
  apiPath: '/v1/employee/bank-account',
  tokenType: 'employee',
  scope: 'bank_account:write',
  body: fullPayload,
  expected: '2xx — a partner should be grantable bank-account-only access',
  answers: 'bank-account-only access',
  verdict: (r) => (ok(r) ? 'as expected' : 'FLAG'),
});

// GET and PUT on this endpoint take the same scheme but different scopes:
// GET also accepts bank_account:read and all:read, PUT does not. So a
// read-only bank token should read and not write — the precise form of
// The "bank-account-only access" requirement.
await run({
  id: 'T4b-read',
  what: 'Read-only bank scope can read',
  method: 'GET',
  apiPath: '/v1/employee/bank-account',
  tokenType: 'employee',
  scope: 'bank_account:read',
  expected: '200 — the GET scope list includes bank_account:read',
  answers: 'bank-account-only access',
  verdict: (r) => (ok(r) ? 'as expected' : 'FLAG'),
});

await run({
  id: 'T4b-write',
  what: 'Read-only bank scope cannot write',
  method: 'PUT',
  apiPath: '/v1/employee/bank-account',
  tokenType: 'employee',
  scope: 'bank_account:read',
  body: fullPayload,
  expected: '403 — bank_account:read is absent from the PUT scope list',
  answers: 'bank-account-only access, scope enforcement',
  verdict: (r) => {
    if (r.tokenError) return 'record — refused at the token exchange';
    if (r.status === 403) return 'as expected';
    if (ok(r)) return 'FLAG — a read-only bank token wrote bank details';
    return 'record';
  },
});

await run({
  id: 'T5',
  what: 'Wrong scope',
  method: 'PUT',
  apiPath: '/v1/employee/bank-account',
  tokenType: 'employee',
  scope: 'timeoff:read',
  body: fullPayload,
  expected: '403, or the token exchange refuses the scope outright',
  answers: 'scope enforcement',
  verdict: (r) => {
    if (r.tokenError) return 'as expected — refused at the token exchange';
    if (r.status === 403) return 'as expected';
    if (ok(r)) return 'FLAG — a timeoff:read token wrote bank details';
    return 'record';
  },
});

// The spec has one T6. Splitting it in two: the public reference declares
// CustomerAPIToken and OAuth2AuthorizationCode for this endpoint and not
// OAuth2Assertion, so "does the admin assertion work" and "does the customer
// API token work" are different questions, and BHR needs both answers.
await run({
  id: 'T6a',
  what: 'Employer-side v2 endpoint, admin assertion token',
  method: 'PUT',
  apiPath: `/v2/employments/${EMPLOYMENT_ID}/bank-account-details`,
  tokenType: 'admin',
  scope: 'all:write',
  body: fullPayload,
  expected:
    'Unknown. The endpoint declares CustomerAPIToken / OAuth2AuthorizationCode, not assertion — record what happens',
  answers: 'endpoint + token',
  verdict: () => 'record',
});

await run({
  id: 'T6b',
  what: 'Employer-side v2 endpoint, customer API token (ra_test_)',
  method: 'PUT',
  apiPath: `/v2/employments/${EMPLOYMENT_ID}/bank-account-details`,
  tokenType: 'customer-api',
  body: fullPayload,
  expected: '2xx — this is the token type the endpoint declares',
  answers: 'endpoint + token',
  skip: PARTNER_TOKEN ? undefined : 'REMOTE_PARTNER_API_TOKEN not set',
  verdict: (r) => (ok(r) ? 'as expected' : 'record'),
});

const t7 = await run({
  id: 'T7',
  what: `Partial payload — only ${mutateField}`,
  method: 'PUT',
  apiPath: '/v1/employee/bank-account',
  tokenType: 'employee',
  scope: 'all:write',
  body: partialPayload,
  expected: '422, or the other fields are cleared. Record which — the design is "replace the whole section"',
  answers: 'whole-section replacement',
  verdict: (r) =>
    ok(r)
      ? 'partial write ACCEPTED — see T7-verify for what happened to the other fields'
      : `partial write rejected (${r.status}) — the full section is mandatory on every write`,
});

await run({
  id: 'T7-verify',
  what: 'Re-read after the partial payload',
  method: 'GET',
  apiPath: '/v1/employee/bank-account',
  tokenType: 'employee',
  scope: 'all:write',
  expected: 'Shows whether the untouched fields survived or were cleared',
  answers: 'whole-section replacement',
  verdict: (r) => {
    if (!ok(r)) return 'FLAG';
    const { flat, count } = accountFromResponse(r.json);
    if (!count) return 'FLAG — no account returned after the partial write';

    // If T7 was rejected, nothing was written, so "the other fields survived"
    // is trivially true and says nothing about replace-vs-merge semantics.
    // Saying otherwise is how a non-result gets read as a result.
    if (!ok({ status: typeof t7.status === 'number' ? t7.status : 0 })) {
      return (
        `not answered — T7 was rejected (${t7.status}), so nothing was written. ` +
        `The API demands the complete section on every write; there is no partial-update path.`
      );
    }

    // Only compare fields the read actually surfaces. label_name is required
    // on write and never returned, so its absence means nothing.
    const comparable = Object.keys(baseDetails).filter(
      (k) => k !== mutateField && k in flat,
    );
    const unreadable = Object.keys(baseDetails).filter(
      (k) => k !== mutateField && !(k in flat),
    );
    const cleared = comparable.filter((k) => flat[k] === undefined || flat[k] === null);

    const note = unreadable.length ? ` (not readable: ${unreadable.join(', ')})` : '';
    if (!comparable.length) return `cannot verify — no written field is readable${note}`;
    return cleared.length
      ? `whole section replaced — cleared: ${cleared.join(', ')}${note}`
      : `other fields survived — the PUT merged rather than replaced${note}`;
  },
});

/* T8 — activation. Irreversible, so two explicit opt-ins. */
const t8Skip = ALLOW_ACTIVATION
  ? undefined
  : 'needs ALLOW_ACTIVATION=true and ALLOW_ACTIVATION_EMPLOYMENT_ID=<the same employment ID>';

await run({
  id: 'T8-activate',
  what: 'Flip the employment to active',
  method: 'PATCH',
  apiPath: `/v1/sandbox/employments/${EMPLOYMENT_ID}`,
  tokenType: 'customer-api',
  body: { status: 'active' },
  expected: 'Unknown. The endpoint declares CustomerAPIToken / OAuth2AuthorizationCode',
  answers: 'post-activation writes (setup)',
  skip: t8Skip ?? (PARTNER_TOKEN ? undefined : 'REMOTE_PARTNER_API_TOKEN not set'),
  verdict: (r) => (ok(r) ? 'as expected' : 'record'),
});

if (ALLOW_ACTIVATION) {
  await run({
    id: 'T8-T1',
    what: 'Read bank details after activation',
    method: 'GET',
    apiPath: '/v1/employee/bank-account',
    tokenType: 'employee',
    scope: 'all:write',
    expected: 'Unknown — the core post-activation question',
    answers: 'post-activation writes',
    verdict: () => 'record',
  });

  await run({
    id: 'T8-T2',
    what: 'Update as employee after activation',
    method: 'PUT',
    apiPath: '/v1/employee/bank-account',
    tokenType: 'employee',
    scope: 'all:write',
    body: fullPayload,
    expected: 'Unknown — the core post-activation question',
    answers: 'post-activation writes',
    verdict: () => 'record',
  });

  await run({
    id: 'T8-T3',
    what: 'Update as company owner after activation',
    method: 'PUT',
    apiPath: '/v1/employee/bank-account',
    tokenType: 'admin',
    scope: 'all:write',
    body: fullPayload,
    expected: '401 or 403, same as T3. A 2xx is a bug',
    answers: 'post-activation writes, endpoint + token',
    verdict: (r) => {
      if (r.status === 401 || r.status === 403) return 'as expected';
      if (ok(r)) return 'FLAG — company-owner token wrote to an employee-assertion endpoint';
      return 'record';
    },
  });
}

/* T9 — split payments. */
await run({
  id: 'T9',
  what: 'Split payments survive a single-account PUT',
  method: 'PUT',
  apiPath: '/v1/employee/bank-account',
  tokenType: 'employee',
  scope: 'all:write',
  body: fullPayload,
  expected: 'Unknown — record whether the split survives',
  answers: 'multiple accounts',
  // Established 2026-09-30: split payments are an EOR-only feature (plus a
  // legacy US payroll-provider carve-out) and are explicitly unsupported for Global
  // Payroll. A split is also employee-self-service in the
  // Remote dashboard with no API surface at all. So for a global_payroll
  // employment there is no split to configure — this is not a sandbox
  // limitation.
  skip: SPLIT_CONFIGURED
    ? undefined
    : 'not applicable — split payments are not supported for Global Payroll (EOR-only). Set SPLIT_CONFIGURED=true only when testing an EOR employment with a split set up by the employee',
  verdict: () => 'record',
});

if (SPLIT_CONFIGURED) {
  await run({
    id: 'T9-verify',
    what: 'Re-read after the single-account PUT',
    method: 'GET',
    apiPath: '/v1/employee/bank-account',
    tokenType: 'employee',
    scope: 'all:write',
    expected: 'How many accounts come back',
    answers: 'multiple accounts',
    verdict: (r) => {
      if (!ok(r)) return 'FLAG';
      const { count } = accountFromResponse(r.json);
      return count > 1 ? `split survived — ${count} accounts` : `split replaced — ${count} account(s)`;
    },
  });
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */
/**
 * The pre-activation run is the baseline for the rest, and T8 changes the
 * employment irreversibly — so an activation run must never overwrite it.
 * Tag the filename, and never clobber an existing report: add a counter.
 */
const stamp = new Date().toISOString().slice(0, 10);
const phase = ALLOW_ACTIVATION ? 'post-activation' : 'pre-activation';
const resultsDir = path.join(PROJECT_ROOT, 'results');
fs.mkdirSync(resultsDir, { recursive: true });

let base = `bank-tests-${stamp}-${phase}`;
for (let n = 2; fs.existsSync(path.join(resultsDir, `${base}.md`)); n += 1) {
  base = `bank-tests-${stamp}-${phase}-${n}`;
}

const jsonPath = path.join(resultsDir, `${base}.json`);
const mdPath = path.join(resultsDir, `${base}.md`);

const meta = {
  runAt: new Date().toISOString(),
  gateway: GATEWAY_NAME,
  gatewayUrl: GATEWAY,
  sdkVersion: '1.58.0',
  employmentId: EMPLOYMENT_ID,
  countryCode: COUNTRY_CODE,
  mutatedField: mutateField,
  originalValue,
  mutatedValue,
  accountCountAfterT2,
  activationRun: ALLOW_ACTIVATION,
  splitConfigured: SPLIT_CONFIGURED,
};

fs.writeFileSync(jsonPath, `${JSON.stringify({ meta, results }, null, 2)}\n`);

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
const flagged = results.filter((r) => String(r.verdict).startsWith('FLAG'));

const md = `# Bank-account test matrix — ${stamp} (${phase})

| | |
|---|---|
| Phase | **${phase}** — T8 ${ALLOW_ACTIVATION ? 'ran, so the employment is now active' : 'did not run; the employment was mid-onboarding'} |
| Gateway | \`${GATEWAY_NAME}\` → ${GATEWAY} |
| SDK version | 1.58.0 |
| Employment | \`${EMPLOYMENT_ID}\` |
| Country | ${COUNTRY_CODE} |
| Field changed | \`${mutateField}\`: ${JSON.stringify(originalValue)} → ${JSON.stringify(mutatedValue)} |
| Accounts returned after T2 | ${accountCountAfterT2 ?? 'n/a'} |
| T8 activation | ${ALLOW_ACTIVATION ? 'run' : 'skipped'} |
| T9 split | ${SPLIT_CONFIGURED ? 'configured' : 'not configured'} |

Full responses: \`${path.basename(jsonPath)}\`.

## Results

Scope columns show what was **requested** and what the gateway **granted**.
They are separate on purpose: recording only the request would make each row's
premise an assumption rather than an observation.

| # | What | Call | Token | Scope requested | Scope granted | Status | Expected | Verdict | Answers |
|---|---|---|---|---|---|---|---|---|---|
${results
  .map(
    (r) =>
      `| ${r.id} | ${esc(r.what)} | \`${esc(r.call)}\` | ${r.tokenType} | \`${esc(r.scope)}\` | ${
        r.grantedScope ? `\`${esc(r.grantedScope)}\`` : '—'
      }${r.scopeMismatch ? ' **MISMATCH**' : ''} | ${esc(r.status ?? '—')} | ${esc(r.expected)} | ${esc(r.verdict)} | ${esc(r.answers)} |`,
  )
  .join('\n')}

## Response previews

${results
  .map(
    (r) => `### ${r.id} — ${r.what}

\`${r.call}\` · ${r.tokenType} / \`${r.scope}\` · **${r.status ?? 'not run'}** · ${r.verdict}

\`\`\`
${r.bodyPreview || '(empty)'}
\`\`\`
`,
  )
  .join('\n')}

## Flags

${
  flagged.length
    ? `${flagged.map((r) => `- **${r.id}** — ${r.what}: ${r.verdict}`).join('\n')}

Every flag above is a result worth recording.`
    : 'No rows flagged in this run.'
}
`;

fs.writeFileSync(mdPath, md);

console.log(`\nWrote results/${path.basename(mdPath)}`);
console.log(`Wrote results/${path.basename(jsonPath)}`);
if (flagged.length) {
  console.log(`\n${flagged.length} flagged row(s) worth recording:`);
  for (const r of flagged) console.log(`  ${r.id}  ${r.verdict}`);
}
console.log('');
