import { useEffect, useState } from 'react';

import {
  PayrollEmployeeOnboardingFlow,
  type PayrollEmployeeOnboardingRenderProps,
} from '@remoteoss/remote-flows';

import { AlertError, emptyErrors, type StepErrors } from './AlertError';
import { AUTH_MODE, DirectAuthProvider, ProxyProvider } from './providers';
import { asText, getRequests, subscribe } from './requestLog';

/**
 * Mode A only: what the browser actually managed to call.
 *
 * There is no proxy log in Mode A, so this is the record. A row with no status
 * is a fetch that never completed — almost always CORS.
 */
function ModeARequestLog() {
  const [, bump] = useState(0);
  useEffect(() => subscribe(() => bump((n) => n + 1)), []);

  const requests = getRequests();
  const gateway = requests.filter((r) => r.crossOrigin);
  const blocked = gateway.filter((r) => r.status === null);
  const refused = gateway.filter((r) => r.status === 401 || r.status === 403);

  return (
    <details className="debug" open>
      <summary>Mode A — direct requests from the browser ({gateway.length} to the gateway)</summary>

      {blocked.length > 0 && (
        <div className="alert error">
          <strong>
            {blocked.length} cross-origin request{blocked.length === 1 ? '' : 's'} never completed.
          </strong>{' '}
          A fetch with no status is the browser refusing to make or read it — check the
          console for the blocked origin or header. This is the Mode A answer:
          a partner cannot reach the gateway directly from the browser.
        </div>
      )}

      {refused.length > 0 && (
        <div className="alert">
          <strong>
            {refused.length} request{refused.length === 1 ? '' : 's'} refused with 401/403.
          </strong>{' '}
          Expected on the reads that do not declare employee-assertion auth —
          <code>onboarding-steps</code> and <code>/v1/countries/…</code>. Record which.
        </div>
      )}

      <pre>{asText() || '(no requests yet — load the flow)'}</pre>

      <div className="buttons-container" style={{ marginTop: 0 }}>
        <button
          type="button"
          className="plain"
          onClick={() => void navigator.clipboard.writeText(asText())}
        >
          Copy log
        </button>
        <button type="button" className="plain" onClick={() => void probeEmployeeEndpoint()}>
          Probe /v1/employee/bank-account with x-rf-employment-id
        </button>
      </div>
      <p className="subtle" style={{ marginTop: 10, marginBottom: 14 }}>
        The flow never reaches a <code>/v1/employee/*</code> call in Mode A — the reads
        above fail first — so nothing carrying the custom{' '}
        <code>x-rf-employment-id</code> header ever gets sent. That header forces a CORS
        preflight, and whether the gateway allows it from localhost is a separate
        question from the 403s. The button fires one directly to settle it.
      </p>
    </details>
  );
}

/**
 * Send one request that the flow itself never gets to: an employee-token call
 * carrying the custom header, cross-origin. A custom header forces a CORS
 * preflight, so this answers whether the gateway permits it from localhost —
 * independently of the authorisation failures on the reads.
 *
 * Goes through the patched fetch, so the result lands in the log above.
 */
async function probeEmployeeEndpoint() {
  const input = document.querySelector<HTMLInputElement>('input[placeholder="UUID from the Admin flow"]');
  const employmentId = input?.value?.trim();
  if (!employmentId) return;

  try {
    const tokenRes = await fetch(`/local/token/employee/${employmentId}`);
    const { accessToken } = (await tokenRes.json()) as { accessToken: string };
    await fetch('https://gateway.partners.remote-sandbox.com/v1/employee/bank-account', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'x-rf-employment-id': employmentId,
      },
    });
  } catch {
    // Already recorded by the patched fetch; a rejection here is the result.
  }
}

const STEP_LABELS: Record<string, string> = {
  personal_details: 'Personal details',
  home_address: 'Home address',
  bank_account: 'Bank account',
  federal_taxes: 'Federal taxes',
  state_taxes: 'State taxes',
};

type FlowProps = {
  employmentId: string;
  countryCode?: string;
  jurisdiction?: string;
};

function EmployeeFlow({ employmentId, countryCode, jurisdiction }: FlowProps) {
  const [errors, setErrors] = useState<StepErrors>(emptyErrors);

  const clearErrors = () => setErrors(emptyErrors);
  const onStepError = (e: { error: Error; fieldErrors: { field: string; messages: string[] }[] }) =>
    setErrors({ apiError: e.error.message, fieldErrors: e.fieldErrors ?? [] });

  return (
    <PayrollEmployeeOnboardingFlow
      employmentId={employmentId}
      countryCode={countryCode || undefined}
      jurisdiction={jurisdiction || undefined}
      // NOTE: `initialValues={{ name }}` was tried here and has no effect — it
      // only seeds fields the form renders, and `name` is not one. The step has
      // to be submitted outside the SDK.
      render={({ employeeBag, components }: PayrollEmployeeOnboardingRenderProps) => {
        const {
          PersonalDetailsStep,
          HomeAddressStep,
          BankAccountStep,
          FederalTaxesStep,
          StateTaxesStep,
          SubmitButton,
          BackButton,
        } = components;

        const currentStep = employeeBag.stepState.currentStep.name;

        // The bank step exists only if onboarding-steps returned a
        // self_onboarding sub-step of this type. If it is missing, that is a
        // result, not a bug in this page — report the raw response below.
        const hasBankStep = employeeBag.selfOnboardingSubsteps.some(
          (s: { type: string }) => s.type === 'employee_provides_bank_details',
        );

        // Why a submit does nothing: the SDK validates client-side and, if a
        // required field is empty, never fires the request. Nothing in the
        // proxy log shows that — the call simply never happens. This reads the
        // bag's own field descriptors so the blocking field is visible.
        const fieldRows = (employeeBag.fields as unknown as Record<string, unknown>[]).map((f) => {
          const name = String(f.name ?? f.id ?? '?');
          const value = (employeeBag.fieldValues as Record<string, unknown>)?.[name];
          // An empty object or array counts as empty too. Composite fields
          // (birth_place on DEU, for example) arrive as `{}` until filled, and
          // treating that as populated undercounts what is blocking the submit.
          const isEmpty =
            value === undefined ||
            value === null ||
            value === '' ||
            (Array.isArray(value) && value.length === 0) ||
            (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
          // `errorMessage` on a JSF descriptor is a map of validation-type to
          // message text — it is always present and says nothing about whether
          // this field is currently invalid. Only a plain string is a real error.
          const raw = f.error ?? f.errorMessage;
          return {
            name,
            required: Boolean(f.required),
            isEmpty,
            value,
            error: typeof raw === 'string' && raw.trim() ? raw : null,
          };
        });
        const blocking = fieldRows.filter((f) => f.required && f.isEmpty);

        const debugPanel = (
          <details className="debug" open>
            <summary>Debug — why a step is or isn't visible</summary>

            {blocking.length > 0 && (
              <div className="alert" style={{ marginTop: 12 }}>
                <strong>
                  {blocking.length} required field
                  {blocking.length === 1 ? '' : 's'} still empty on this step.
                </strong>{' '}
                The SDK validates before sending, so the submit button will do nothing
                and no request will appear in the proxy log until these are filled:
                <ul>
                  {blocking.map((f) => (
                    <li key={f.name}>
                      <code>{f.name}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/*
              Jump straight to a step. The bag exposes goToStep, and a blocked
              step should not be able to hold the whole run hostage — the bank
              step is the one the partner bank-details questions depend on.

              Jumping does NOT submit the step you leave. Anything you skip is
              unsaved unless you sent it another way (see
              scripts/put-employee-step.mjs). Note which steps were skipped and
              how they were satisfied, or the run is not reproducible.
            */}
            <p className="subtle" style={{ margin: '0 0 6px' }}>
              Jump to step — skips without submitting:
            </p>
            <div className="buttons-container" style={{ marginTop: 0, marginBottom: 16 }}>
              {(
                ['personal_details', 'home_address', 'bank_account'] as const
              ).map((key) => (
                <button
                  key={key}
                  type="button"
                  className="plain"
                  disabled={key === currentStep || (key === 'bank_account' && !hasBankStep)}
                  onClick={() => employeeBag.goToStep(key)}
                >
                  {STEP_LABELS[key]}
                </button>
              ))}
            </div>

            <p className="subtle" style={{ margin: '0 0 6px' }}>
              Fields on this step (required · value · error):
            </p>
            <pre>
              {fieldRows
                .map(
                  (f) =>
                    `${f.required ? '*' : ' '} ${f.name.padEnd(26)} ${
                      f.isEmpty ? '(empty)' : JSON.stringify(f.value)
                    }${f.error ? `   !! ${f.error}` : ''}`,
                )
                .join('\n') || '(none)'}
            </pre>

            <dl>
              <dt>countryCode</dt>
              <dd>
                <code>{employeeBag.countryCode ?? '—'}</code>
                {!countryCode && ' (derived from GET /v1/employments/{id})'}
              </dd>
              <dt>jurisdiction</dt>
              <dd>
                <code>{employeeBag.jurisdiction ?? '—'}</code>
              </dd>
              <dt>current step</dt>
              <dd>
                <code>{currentStep}</code>
              </dd>
              <dt>isComplete</dt>
              <dd>{String(employeeBag.isComplete)}</dd>
              <dt>bank step present</dt>
              <dd>{String(hasBankStep)}</dd>
              <dt>taxStepsAvailability</dt>
              <dd>
                <code>{JSON.stringify(employeeBag.taxStepsAvailability)}</code>
              </dd>
            </dl>
            <p className="subtle" style={{ margin: '0 0 6px' }}>
              <code>employeeBag.selfOnboardingSubsteps</code> (raw):
            </p>
            <pre>{JSON.stringify(employeeBag.selfOnboardingSubsteps, null, 2)}</pre>
            <p className="subtle" style={{ margin: '0 0 6px' }}>
              <code>employeeBag.apiSteps</code> (raw onboarding-steps response):
            </p>
            <pre>{JSON.stringify(employeeBag.apiSteps ?? null, null, 2)}</pre>
          </details>
        );

        if (employeeBag.isLoading && !employeeBag.fields.length) {
          return <p>Loading…</p>;
        }

        if (!employeeBag.countryCode) {
          return (
            <>
              <div className="alert error">
                <strong>Could not determine country</strong> for employment{' '}
                <code>{employmentId}</code>. In proxy mode the flow reads{' '}
                <code>GET /v1/employments/&#123;id&#125;</code> on the admin token; check the
                server console for that call's status. In direct mode (Mode A) an
                employee-only token cannot make that call at all — pass a country code.
              </div>
              {debugPanel}
            </>
          );
        }

        const isUSA = employeeBag.countryCode === 'USA';

        return (
          <>
            <p className="steps-trail">
              {Object.entries(STEP_LABELS)
                .filter(([key]) => {
                  if (key === 'bank_account') return hasBankStep;
                  if (key === 'federal_taxes') return isUSA;
                  if (key === 'state_taxes') return isUSA && !!employeeBag.jurisdiction;
                  return true;
                })
                .map(([key, label], i) => (
                  <span key={key}>
                    {i > 0 && ' › '}
                    <span className={key === currentStep ? 'current' : undefined}>{label}</span>
                  </span>
                ))}
            </p>

            {!hasBankStep && (
              <div className="alert">
                <strong>
                  No <code>employee_provides_bank_details</code> sub-step returned by
                  onboarding-steps.
                </strong>{' '}
                The bank step will not render. Stop and report the raw sub-steps below
                together with the country — availability may depend on the country or
                legal entity (inferred, not confirmed).
              </div>
            )}

            {currentStep === 'personal_details' && (
              <>
                <PersonalDetailsStep onError={onStepError} onSuccess={clearErrors} />
                <AlertError errors={errors} />
                <div className="buttons-container">
                  <SubmitButton
                    className="submit-button"
                    onClick={clearErrors}
                    disabled={!employeeBag.fields.length}
                  >
                    Save personal details
                  </SubmitButton>
                </div>
              </>
            )}

            {currentStep === 'home_address' && (
              <>
                <HomeAddressStep onError={onStepError} onSuccess={clearErrors} />
                <AlertError errors={errors} />
                <div className="buttons-container">
                  <BackButton className="back-button" onClick={clearErrors}>
                    Back
                  </BackButton>
                  <SubmitButton className="submit-button" onClick={clearErrors}>
                    Save home address
                  </SubmitButton>
                </div>
              </>
            )}

            {currentStep === 'bank_account' && hasBankStep && (
              <>
                <BankAccountStep onError={onStepError} onSuccess={clearErrors} />
                <AlertError errors={errors} />
                <div className="buttons-container">
                  <BackButton className="back-button" onClick={clearErrors}>
                    Back
                  </BackButton>
                  <SubmitButton className="submit-button" onClick={clearErrors}>
                    Save bank account
                  </SubmitButton>
                </div>
                <p className="subtle" style={{ marginTop: 14 }}>
                  Once this succeeds, capture the payload for the bank matrix:
                  <br />
                  <code>EMPLOYMENT_ID={employmentId} npm run fixture</code>
                </p>
              </>
            )}

            {currentStep === 'federal_taxes' && (
              <>
                {employeeBag.taxStepsAvailability.federal_taxes.isAvailable ? (
                  <>
                    <FederalTaxesStep onError={onStepError} onSuccess={clearErrors} />
                    <AlertError errors={errors} />
                    <div className="buttons-container">
                      <BackButton className="back-button" onClick={clearErrors}>
                        Back
                      </BackButton>
                      <SubmitButton className="submit-button" onClick={clearErrors}>
                        Save federal taxes
                      </SubmitButton>
                    </div>
                  </>
                ) : (
                  <div className="alert">
                    Federal taxes unavailable:{' '}
                    <code>
                      {employeeBag.taxStepsAvailability.federal_taxes.unavailableReason ?? 'unknown'}
                    </code>
                    . Tax steps are out of scope for this work.
                  </div>
                )}
              </>
            )}

            {currentStep === 'state_taxes' && (
              <>
                {employeeBag.taxStepsAvailability.state_taxes.isAvailable ? (
                  <>
                    <StateTaxesStep onError={onStepError} onSuccess={clearErrors} />
                    <AlertError errors={errors} />
                    <div className="buttons-container">
                      <BackButton className="back-button" onClick={clearErrors}>
                        Back
                      </BackButton>
                      <SubmitButton className="submit-button" onClick={clearErrors}>
                        Save state taxes
                      </SubmitButton>
                    </div>
                  </>
                ) : (
                  <div className="alert">
                    State taxes unavailable:{' '}
                    <code>
                      {employeeBag.taxStepsAvailability.state_taxes.unavailableReason ?? 'unknown'}
                    </code>
                    . Tax steps are out of scope for this work.
                  </div>
                )}
              </>
            )}

            {employeeBag.isComplete && (
              <div className="alert ok">
                <strong>Employee onboarding complete.</strong>
              </div>
            )}

            {debugPanel}
          </>
        );
      }}
    />
  );
}

export function EmployeeFlowPage({
  employmentId,
  setEmploymentId,
}: {
  employmentId: string;
  setEmploymentId: (id: string) => void;
}) {
  const [countryCode, setCountryCode] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');
  const [started, setStarted] = useState(false);

  const flow = (
    <EmployeeFlow
      employmentId={employmentId}
      countryCode={countryCode}
      jurisdiction={jurisdiction}
    />
  );

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Employee onboarding</h2>
      <p className="subtle">
        In proxy mode the <code>/v1/employee/*</code> writes go out on the employee
        token and everything else on the admin token. Watch the server console to see
        the split.
      </p>

      <div className="row">
        <label className="field" style={{ flexBasis: '100%' }}>
          Employment ID
          <input
            value={employmentId}
            onChange={(e) => {
              setEmploymentId(e.target.value.trim());
              setStarted(false);
            }}
            placeholder="UUID from the Admin flow"
            spellCheck={false}
          />
        </label>
        <label className="field">
          Country code (optional, ISO alpha-3)
          <input
            value={countryCode}
            onChange={(e) => {
              setCountryCode(e.target.value.trim().toUpperCase());
              setStarted(false);
            }}
            placeholder="GBR"
            spellCheck={false}
          />
        </label>
        <label className="field">
          Jurisdiction (US only)
          <input
            value={jurisdiction}
            onChange={(e) => {
              setJurisdiction(e.target.value.trim());
              setStarted(false);
            }}
            placeholder="CA"
            spellCheck={false}
          />
        </label>
      </div>

      <div className="alert">
        <strong>Personal details cannot be submitted through this flow on GBR.</strong>{' '}
        The schema requires <code>name</code>, the PUT endpoint rejects it
        (<code>additionalProperties: false</code>), and the SDK strips it — so
        validation blocks a submit that could never have succeeded. Seeding{' '}
        <code>initialValues</code> does not help; it only reaches rendered fields.
        Submit the step directly instead, then reload this tab:
        <pre style={{ marginBottom: 0 }}>
          {`EMPLOYMENT_ID=${employmentId || '<id>'} \\\n  node scripts/put-employee-step.mjs personal '{"given_name":"…","surname":"…","sex":"male","birthdate":"1990-01-01"}'`}
        </pre>
      </div>

      {AUTH_MODE === 'direct' && !countryCode && (
        <div className="alert">
          <strong>Mode A needs a country code.</strong> An employee-only token gets a
          401 on <code>GET /v1/employments/&#123;id&#125;</code>, so the flow has nothing to
          derive the country from.
        </div>
      )}

      <div className="buttons-container">
        <button
          type="button"
          className="submit-button"
          disabled={!employmentId || started}
          onClick={() => setStarted(true)}
        >
          {started ? 'Flow loaded' : 'Load employee flow'}
        </button>
        {started && (
          <button type="button" className="plain" onClick={() => setStarted(false)}>
            Reset
          </button>
        )}
      </div>

      {started && employmentId && (
        <div style={{ marginTop: 24 }}>
          {AUTH_MODE === 'direct' ? (
            <DirectAuthProvider tokenUrl={`/local/token/employee/${employmentId}`}>
              {flow}
            </DirectAuthProvider>
          ) : (
            <ProxyProvider>{flow}</ProxyProvider>
          )}
        </div>
      )}

      {AUTH_MODE === 'direct' && <ModeARequestLog />}
    </div>
  );
}
