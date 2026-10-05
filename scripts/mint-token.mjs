#!/usr/bin/env node
/**
 * Mint a token from the command line.
 *
 *   node scripts/mint-token.mjs admin [--scope "all:write"] [--raw]
 *   node scripts/mint-token.mjs employee <employmentId> [--scope "bank_account:write"] [--raw]
 *
 * --raw prints the token and nothing else, so this works:
 *   TOKEN=$(node scripts/mint-token.mjs employee <id> --raw)
 *   curl -H "Authorization: Bearer $TOKEN" $GATEWAY/v1/employee/current
 */
import {
  GATEWAY,
  GATEWAY_NAME,
  adminSub,
  employeeSub,
  mintToken,
  redact,
  requireEnv,
} from '../server/token.js';

const argv = process.argv.slice(2);
const positional = [];
let scope = 'all:write';
let raw = false;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--raw') raw = true;
  else if (arg === '--scope') scope = argv[(i += 1)];
  else if (arg.startsWith('--scope=')) scope = arg.slice('--scope='.length);
  else if (arg.startsWith('--')) usage(`Unknown flag ${arg}`);
  else positional.push(arg);
}

const [kind, maybeEmploymentId] = positional;

function usage(msg) {
  if (msg) console.error(`\n✖ ${msg}`);
  console.error(`
Usage:
  node scripts/mint-token.mjs admin [--scope "all:write"] [--raw]
  node scripts/mint-token.mjs employee <employmentId> [--scope "bank_account:write"] [--raw]
`);
  process.exit(1);
}

if (kind !== 'admin' && kind !== 'employee') usage('First argument must be "admin" or "employee".');
if (kind === 'employee' && !maybeEmploymentId) usage('The employee subject needs an employment ID.');
if (!scope) usage('--scope needs a value.');

try {
  if (kind === 'admin') requireEnv(['REMOTE_OWNER_USER_ID']);
  const sub = kind === 'admin' ? adminSub() : employeeSub(maybeEmploymentId);
  const token = await mintToken(sub, scope, { noCache: true });

  if (raw) {
    process.stdout.write(token.accessToken);
  } else {
    console.log(`gateway     ${GATEWAY_NAME} → ${GATEWAY}`);
    console.log(`sub         ${sub}`);
    console.log(`scope       ${token.scope}`);
    console.log(`expires_in  ${token.expiresIn}`);
    console.log(`token       ${redact(token.accessToken)}`);
    if (kind === 'employee') {
      console.log(`
Confirm the token's identity before trusting any test result:
  TOKEN=$(node scripts/mint-token.mjs employee ${maybeEmploymentId} --raw)
  curl -s -H "Authorization: Bearer $TOKEN" ${GATEWAY}/v1/employee/current | head -c 400`);
    }
  }
} catch (err) {
  console.error(`\n✖ ${err.message}`);
  if (/unsupported_grant_type/.test(err.message)) {
    console.error(
      `\nThis client is not enabled for the jwt-bearer grant. Stop here —\n` +
        `either the client needs enabling, or reuse the example app's partners-sandbox client.`,
    );
  }
  if (/invalid_client/.test(err.message)) {
    console.error(
      `\nWrong client ID/secret pair, or credentials from a different environment.\n` +
        `Check that REMOTE_GATEWAY (${GATEWAY_NAME}) matches the credentials in .env.`,
    );
  }
  process.exit(1);
}
