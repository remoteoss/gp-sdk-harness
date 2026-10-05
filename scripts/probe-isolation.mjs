#!/usr/bin/env node
/**
 * Does our partner client's reach stop at the companies it manages?
 *
 *   OUR_EMPLOYMENT_ID=<id> OTHER_EMPLOYMENT_ID=<id> node scripts/probe-isolation.mjs
 *   ... add --confirm-access-probe to also make ONE call with any token that mints
 *
 * Why this exists: every other test in this harness acts on a company the
 * tester owns, so it measures what a partner can do for its *own* customer.
 * It never crosses the boundary that a partner security review actually asks
 * about — can this client act on a company it does not manage? Remote's
 * design doc says `sub` must belong to "a company that is authorized for the
 * given partner", so the expectation is a refusal. This checks it.
 *
 * Three subjects, so the result is interpretable rather than just a status:
 *
 *   A  our own employment          control — must succeed
 *   B  a random, nonexistent UUID  does the exchange validate existence at all?
 *   C  a real employment in another company   the actual isolation boundary
 *
 * If B mints, then minting proves nothing about authorisation and the boundary
 * is enforced at call time instead — which changes how C should be read.
 *
 * DELIBERATE RESTRAINT, because C involves data that is not ours:
 *   - no request is made with the B or C tokens unless --confirm-access-probe
 *   - even then, exactly one call, and only its HTTP status is printed
 *   - response bodies for B and C are never read, logged or saved
 * A minted token for someone else's employment is itself the finding. Using it
 * to read their data would not make the finding truer.
 *
 * Read-only. Zero dependencies.
 */
import { GATEWAY, GATEWAY_NAME, employeeSub, mintToken } from '../server/token.js';

const OURS = process.env.OUR_EMPLOYMENT_ID;
const OTHER = process.env.OTHER_EMPLOYMENT_ID;
const PROBE = process.argv.includes('--confirm-access-probe');

if (!OURS) {
  console.error(`
✖ OUR_EMPLOYMENT_ID is required (the control).

  OUR_EMPLOYMENT_ID=<id> OTHER_EMPLOYMENT_ID=<id> node scripts/probe-isolation.mjs
`);
  process.exit(1);
}

const randomUuid = () =>
  '10000000-2000-4000-8000-' + Math.floor(Math.random() * 1e12).toString().padStart(12, '0');

const cases = [
  { id: 'A', label: 'our own employment (control)', employmentId: OURS, expect: 'mints and works' },
  { id: 'B', label: 'random nonexistent employment', employmentId: randomUuid(), expect: 'unknown — tells us whether the exchange validates the subject' },
];
if (OTHER) {
  cases.push({
    id: 'C',
    label: 'a real employment in a company this client does not manage',
    employmentId: OTHER,
    expect: 'should be refused',
    foreign: true,
  });
}

console.log(`\nPartner isolation probe on ${GATEWAY_NAME}`);
console.log(`  client   ${process.env.REMOTE_CLIENT_ID?.slice(0, 8)}…`);
console.log(`  access   ${PROBE ? 'one status-only call per minted token' : 'token exchange only (pass --confirm-access-probe to add one call)'}`);
if (!OTHER) {
  console.log(`\n  ! OTHER_EMPLOYMENT_ID not set, so the isolation case (C) is skipped.`);
  console.log(`    Use an employment ID from a company this client does NOT manage.`);
}
console.log('');

const results = [];

for (const c of cases) {
  let minted = false;
  let mintDetail = '';

  try {
    const token = await mintToken(employeeSub(c.employmentId), 'all:write', { noCache: true });
    minted = true;
    mintDetail = `expires_in ${token.expiresIn}`;

    if (PROBE) {
      // One call. Status only — the body is deliberately not read for B or C.
      const res = await fetch(`${GATEWAY}/v1/employee/bank-account`, {
        headers: { Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json' },
      });
      mintDetail += `, call -> HTTP ${res.status}`;
      if (c.foreign && res.status >= 200 && res.status < 300) {
        mintDetail += '  *** ACCESS GRANTED TO ANOTHER COMPANY ***';
      }
    }
  } catch (err) {
    const m = /HTTP (\d{3})/.exec(err.message);
    mintDetail = `refused${m ? ` (HTTP ${m[1]})` : ''} — ${err.message.split('\n')[0].slice(0, 120)}`;
  }

  results.push({ ...c, minted, mintDetail });

  console.log(`${c.id}  ${c.label}`);
  console.log(`    sub      ${employeeSub(c.employmentId)}`);
  console.log(`    expected ${c.expect}`);
  console.log(`    result   ${minted ? 'TOKEN ISSUED' : 'no token'} — ${mintDetail}\n`);
}

/* ------------------------------------------------------------------ *
 * Interpretation
 * ------------------------------------------------------------------ */
const a = results.find((r) => r.id === 'A');
const b = results.find((r) => r.id === 'B');
const c = results.find((r) => r.id === 'C');

console.log('─'.repeat(70));
console.log('Reading this:\n');

if (!a?.minted) {
  console.log('  A failed, so the probe itself is broken. Nothing below is meaningful.');
  process.exit(1);
}

if (b?.minted) {
  console.log('  B minted a token for an employment that does not exist, so the token');
  console.log('  exchange does NOT validate the subject. Minting therefore proves nothing');
  console.log('  about authorisation, and the boundary must be enforced at call time.');
  if (!PROBE) {
    console.log('\n  → Re-run with --confirm-access-probe. Without a call, C cannot be judged.');
  }
} else {
  console.log('  B was refused, so the exchange does validate the subject at mint time.');
  console.log('  That makes C meaningful on its own: a refusal there is real isolation.');
}

if (c) {
  console.log('');
  if (!c.minted) {
    console.log('  C was refused. The client cannot mint for a company it does not manage —');
    console.log('  the partner boundary holds at the token exchange. This is the good result.');
  } else if (!PROBE) {
    console.log('  C MINTED A TOKEN for another company\'s employment. Whether that token can');
    console.log('  actually read anything is unknown without a call. Re-run with');
    console.log('  --confirm-access-probe to find out, then stop and escalate either way.');
  } else if (/ACCESS GRANTED/.test(c.mintDetail)) {
    console.log('  C READ ANOTHER COMPANY\'S DATA. Stop testing and escalate now —');
    console.log('  #dev-team-powered-by-remote-eng, and treat it as a security issue,');
    console.log('  not an API finding. Do not enumerate further.');
  } else {
    console.log('  C minted a token but the call was refused, so the boundary is enforced');
    console.log('  at call time rather than at the exchange. Isolation holds, but the');
    console.log('  gateway issues tokens it will never honour — worth reporting as its own');
    console.log('  point, since it makes a partner\'s own error handling harder.');
  }
}

console.log('');
