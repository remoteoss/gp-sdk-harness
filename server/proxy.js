/**
 * The one-rule proxy (Mode B).
 *
 *   /v1/employee/*  -> employee token (sub = employment)
 *   everything else -> admin token    (sub = company owner user)
 *
 * That single rule is deliberate. The hosted demo sniffs many paths and has
 * picked the wrong token before; these tests are specifically about tokens,
 * so the routing has to be something we can state in one line.
 */
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { GATEWAY, PROJECT_ROOT, adminSub, employeeSub, mintToken } from './token.js';

const LOG_PATH = path.join(PROJECT_ROOT, 'results', 'proxy-log.jsonl');

/**
 * Headers we pass upstream. Everything else is dropped on purpose:
 *  - host / origin / cookie  — belong to localhost, not the gateway
 *  - content-length          — the body may be re-encoded
 *  - accept-encoding         — Node's fetch decompresses for us
 *  - authorization           — the SDK sends a placeholder; we set the real one
 *  - x-rf-employment-id      — routing input, not an upstream parameter
 */
const FORWARD_HEADERS = ['content-type', 'accept', 'x-client-name', 'x-client-version'];

/**
 * WORKAROUND(SDK): fields the API requires but its own form schema hides.
 *
 * GBR `global_payroll_contract_details` declares `overtime_eligible` with
 * `x-jsf-presentation.inputType: "hidden"`, leaves it out of `required`, and
 * gates the only rule that would require it on `"if": false` — which never
 * matches. So the SDK correctly renders no input, the field never enters form
 * values, and `PUT /v2/employments/{id}/contract-details` then rejects the
 * save with `overtime_eligible — can't be blank`.
 *
 * `initialValues` on the flow does not help: the field is dropped before the
 * payload is built. `options.jsfModify` would be the natural fix but both GP
 * flows type it away (`Omit<FlowOptions, 'jsfModify' | 'jsonSchemaVersion'>`).
 * So the injection happens here, on the wire, as late as possible.
 *
 * Every injection is logged to the console and to proxy-log.jsonl with
 * `injected: [...]`, so no test result can silently depend on it.
 *
 * Delete this once the schema and the validator agree.
 */
const FIELD_INJECTIONS = [
  {
    match: /^\/v2\/employments\/[^/]+\/contract-details$/i,
    fields: { overtime_eligible: 'no' },
  },
];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Where the fields actually belong.
 *
 * These payloads are sometimes enveloped — the bank endpoint takes
 * `{ bank_account_details: {...} }` — so injecting at the top level can put
 * the field somewhere the validator never looks. When the body is a single
 * key wrapping an object, treat that inner object as the target.
 */
function injectionTarget(parsed) {
  const keys = Object.keys(parsed);
  if (keys.length === 1 && isPlainObject(parsed[keys[0]])) {
    return { target: parsed[keys[0]], where: keys[0] };
  }
  return { target: parsed, where: '(top level)' };
}

/** Returns the patched body and the names injected, or null if nothing applied. */
function applyInjections(apiPath, body, contentType) {
  if (!body || !/json/i.test(contentType ?? '')) return null;
  const rule = FIELD_INJECTIONS.find((r) => r.match.test(apiPath.split('?')[0]));
  if (!rule) return null;

  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const { target, where } = injectionTarget(parsed);

  const injected = [];
  for (const [key, value] of Object.entries(rule.fields)) {
    if (target[key] === undefined || target[key] === null || target[key] === '') {
      target[key] = value;
      injected.push(key);
    }
  }
  if (!injected.length) return null;

  return { body: Buffer.from(JSON.stringify(parsed)), injected, where };
}

/**
 * Save the request and response of any failed call.
 *
 * Ground rule 5 is "surface real errors", and a status code on its own does
 * not. The 422 that blocked the employer flow said which field was wrong but nothing
 * about where the payload put it. These are sandbox test employments, so the
 * bodies are fake data and safe to keep; tokens live in headers, which are
 * never written here.
 */
function captureFailure({ method, apiPath, status, requestBody, responseText, injected, where }) {
  try {
    const dir = path.join(PROJECT_ROOT, 'results', 'failures');
    fs.mkdirSync(dir, { recursive: true });
    const safe = apiPath.split('?')[0].replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${method}-${safe}.json`);

    const parse = (t) => {
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
    };

    fs.writeFileSync(
      file,
      `${JSON.stringify(
        {
          ts: new Date().toISOString(),
          method,
          path: apiPath,
          status,
          injected: injected ?? null,
          injectedInto: where ?? null,
          requestBody: requestBody ? parse(requestBody.toString('utf8')) : null,
          responseBody: parse(responseText),
        },
        null,
        2,
      )}\n`,
    );
    console.log(`[proxy] wrote results/failures/${path.basename(file)}`);
  } catch (err) {
    console.error('[proxy] could not capture failure:', err.message);
  }
}

function appendLog(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    // A logging failure must never take the proxy down.
    console.error('[proxy] could not write proxy-log.jsonl:', err.message);
  }
}

export const proxy = express.Router();

// Raw body: we re-send bytes untouched rather than re-serialising JSON.
proxy.use(express.raw({ type: '*/*', limit: '100mb' }));

proxy.use(async (req, res) => {
  const startedAt = Date.now();
  const apiPath = req.originalUrl.replace(/^\/api/, ''); // '/v1/...?...'
  const employmentId = req.get('x-rf-employment-id');

  // Tests only. Lets bank-tests.mjs and curl aim the "wrong" token at an
  // endpoint on purpose — that is the whole point of T3.
  const forced = req.get('x-harness-force-token'); // 'admin' | 'employee'
  const isEmployeePath = /^\/v1\/employee\//i.test(apiPath);
  const useEmployee = forced ? forced === 'employee' : isEmployeePath;

  try {
    if (useEmployee && !employmentId) {
      // Log it too — the point of the log is a complete record of what the
      // flow called, and a missing header is itself worth seeing.
      console.log(`[proxy] ${req.method} ${apiPath} -> 400 (no x-rf-employment-id)`);
      appendLog({
        ts: new Date().toISOString(),
        method: req.method,
        path: apiPath,
        status: 400,
        tokenType: 'employee',
        error: 'x-rf-employment-id header missing',
        durationMs: Date.now() - startedAt,
      });
      return res.status(400).json({
        error: 'x-rf-employment-id header required for employee token',
        path: apiPath,
      });
    }

    const { accessToken } = await mintToken(
      useEmployee ? employeeSub(employmentId) : adminSub(),
    );

    const headers = { Authorization: `Bearer ${accessToken}` };
    for (const h of FORWARD_HEADERS) {
      const v = req.get(h);
      if (v) headers[h] = v;
    }

    let body = Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;

    const patch = applyInjections(apiPath, body, req.get('content-type'));
    if (patch) {
      body = patch.body;
      // Loud on purpose. A silently patched payload would make every result
      // downstream of it untrustworthy.
      console.log(
        `[proxy] WORKAROUND injected ${patch.injected.join(', ')} into ${patch.where} of ${req.method} ${apiPath}`,
      );
    }

    const upstream = await fetch(`${GATEWAY}${apiPath}`, {
      method: req.method,
      headers,
      body,
    });

    // Do not copy content-encoding or content-length: fetch already
    // decompressed the body and the length no longer matches.
    const buf = Buffer.from(await upstream.arrayBuffer());
    const tokenType = useEmployee ? 'employee' : 'admin';

    if (upstream.status >= 400) {
      captureFailure({
        method: req.method,
        apiPath,
        status: upstream.status,
        requestBody: body,
        responseText: buf.toString('utf8'),
        injected: patch?.injected,
        where: patch?.where,
      });
    }

    console.log(
      `[proxy] ${req.method} ${apiPath} -> ${upstream.status} (${tokenType} token, ${Date.now() - startedAt}ms)`,
    );
    appendLog({
      ts: new Date().toISOString(),
      method: req.method,
      path: apiPath,
      status: upstream.status,
      tokenType,
      forced: Boolean(forced),
      employmentId: useEmployee ? employmentId : undefined,
      injected: patch ? patch.injected : undefined,
      durationMs: Date.now() - startedAt,
    });

    res
      .status(upstream.status)
      .type(upstream.headers.get('content-type') ?? 'application/json')
      .send(buf);
  } catch (err) {
    // Surface the real error. Generic 500s hid the cause of past auth failures.
    console.error(`[proxy] ${req.method} ${apiPath} failed:`, err.message);
    appendLog({
      ts: new Date().toISOString(),
      method: req.method,
      path: apiPath,
      status: err.status ?? 502,
      tokenType: useEmployee ? 'employee' : 'admin',
      error: err.message,
      durationMs: Date.now() - startedAt,
    });
    res.status(err.status ?? 502).json({ error: err.message });
  }
});
