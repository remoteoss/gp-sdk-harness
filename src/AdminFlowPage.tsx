import { useState } from 'react';

import {
  PayrollAdminOnboardingFlow,
  type PayrollAdminOnboardingRenderProps,
} from '@remoteoss/remote-flows';

import { AlertError, emptyErrors, type StepErrors } from './AlertError';
import { AUTH_MODE, DirectAuthProvider, ProxyProvider } from './providers';

const COMPANY_ID = import.meta.env.VITE_COMPANY_ID;

const STEP_LABELS: Record<string, string> = {
  select_country: 'Country',
  contract_details: 'Contract details',
  administrative_details: 'Administrative details',
  invite: 'Invitation',
};

type Props = {
  /** Hand the created employment ID to the Employee tab. */
  onEmploymentCreated: (employmentId: string) => void;
  onOpenEmployeeTab: () => void;
};

function AdminFlow({ onEmploymentCreated, onOpenEmployeeTab }: Props) {
  const [errors, setErrors] = useState<StepErrors>(emptyErrors);
  const [invited, setInvited] = useState(false);
  const [copied, setCopied] = useState(false);

  const clearErrors = () => setErrors(emptyErrors);
  const onStepError = (e: { error: Error; fieldErrors: { field: string; messages: string[] }[] }) =>
    setErrors({ apiError: e.error.message, fieldErrors: e.fieldErrors ?? [] });

  if (!COMPANY_ID) {
    return (
      <div className="alert error">
        <strong>VITE_COMPANY_ID is not set.</strong> Add it to <code>.env</code> and
        restart. Do not guess the value.
      </div>
    );
  }

  return (
    <PayrollAdminOnboardingFlow
      companyId={COMPANY_ID}
      // NOTE: seeding `initialValues={{ overtime_eligible: 'no' }}` here was
      // tried and does NOT work — a field the schema marks hidden is dropped
      // before the payload is built, so the value never reaches the wire.
      // The injection had to move to server/proxy.js (FIELD_INJECTIONS).
      render={({ adminBag, components }: PayrollAdminOnboardingRenderProps) => {
        const {
          SelectCountryStep,
          ContractDetailsStep,
          AdministrativeDetailsStep,
          InvitationStep,
          SubmitButton,
          BackButton,
        } = components;

        const currentStep = adminBag.stepState.currentStep.name;

        if (adminBag.isLoading && adminBag.fields.length === 0) {
          return <p>Loading…</p>;
        }

        // A failed legal-entity fetch and a company with no GP entity both
        // leave legalEntities empty, so check the error flag first.
        if (!adminBag.isLoading && adminBag.isErrorLegalEntities) {
          return (
            <div className="alert error">
              <strong>Could not load legal entities</strong> for company{' '}
              <code>{COMPANY_ID}</code>. Check the server console for the upstream
              status — this is a request failure, not "no GP entity".
            </div>
          );
        }

        if (!adminBag.isLoading && adminBag.legalEntities.length === 0) {
          return (
            <div className="alert error">
              <strong>No GP-enabled legal entity found</strong> for company{' '}
              <code>{COMPANY_ID}</code>. Stop here and check the company's legal entities — the sandbox
              helper endpoints that would fix this change shared data.
            </div>
          );
        }

        const renderStep = () => {
          switch (currentStep) {
            case 'select_country': {
              const isFormReady = !!adminBag.countryCode && adminBag.fields.length > 0;
              return (
                <>
                  <SelectCountryStep onError={onStepError} onSuccess={clearErrors} />
                  <AlertError errors={errors} />
                  <div className="buttons-container">
                    <SubmitButton
                      className="submit-button"
                      onClick={clearErrors}
                      disabled={!isFormReady}
                    >
                      Create employment
                    </SubmitButton>
                  </div>
                </>
              );
            }
            case 'contract_details':
              return (
                <>
                  <ContractDetailsStep onError={onStepError} onSuccess={clearErrors} />
                  <AlertError errors={errors} />
                  <div className="buttons-container">
                    <BackButton className="back-button" onClick={clearErrors}>
                      Back
                    </BackButton>
                    <SubmitButton className="submit-button" onClick={clearErrors}>
                      Save contract details
                    </SubmitButton>
                  </div>
                </>
              );
            case 'administrative_details':
              return (
                <>
                  {/* This step has been seen rendering the contract-details form
                      instead of its own. Compare the fields below with the
                      previous step before submitting. */}
                  <AdministrativeDetailsStep onError={onStepError} onSuccess={clearErrors} />
                  <AlertError errors={errors} />
                  <div className="buttons-container">
                    <BackButton className="back-button" onClick={clearErrors}>
                      Back
                    </BackButton>
                    <SubmitButton className="submit-button" onClick={clearErrors}>
                      Save administrative details
                    </SubmitButton>
                  </div>
                </>
              );
            case 'invite':
              return (
                <>
                  <AlertError errors={errors} />
                  <div className="buttons-container">
                    <BackButton className="back-button" onClick={clearErrors}>
                      Back
                    </BackButton>
                    <InvitationStep
                      onSuccess={() => {
                        clearErrors();
                        setInvited(true);
                        if (adminBag.employmentId) onEmploymentCreated(adminBag.employmentId);
                      }}
                      onError={onStepError}
                    >
                      Send invitation
                    </InvitationStep>
                  </div>
                </>
              );
            default:
              return null;
          }
        };

        return (
          <>
            <p className="steps-trail">
              {Object.entries(STEP_LABELS).map(([key, label], i) => (
                <span key={key}>
                  {i > 0 && ' › '}
                  <span className={key === currentStep ? 'current' : undefined}>{label}</span>
                </span>
              ))}
            </p>

            {invited ? (
              <div className="alert ok">
                <strong>Invitation sent.</strong> The employment is now waiting on the
                employee side of onboarding.
              </div>
            ) : (
              renderStep()
            )}

            {adminBag.employmentId && (
              <div className="alert">
                <p style={{ margin: 0 }}>
                  Employment ID <code>{adminBag.employmentId}</code>
                </p>
                <div className="buttons-container">
                  <button
                    type="button"
                    className="plain"
                    onClick={() => {
                      void navigator.clipboard.writeText(adminBag.employmentId ?? '');
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    {copied ? 'Copied' : 'Copy ID'}
                  </button>
                  <button
                    type="button"
                    className="plain"
                    onClick={() => {
                      onEmploymentCreated(adminBag.employmentId ?? '');
                      onOpenEmployeeTab();
                    }}
                  >
                    Open in Employee flow
                  </button>
                </div>
              </div>
            )}

            <details className="debug">
              <summary>Debug</summary>
              <dl>
                <dt>current step</dt>
                <dd>
                  <code>{currentStep}</code>
                </dd>
                <dt>country</dt>
                <dd>
                  <code>{adminBag.countryCode ?? '—'}</code>
                </dd>
                <dt>legal entity</dt>
                <dd>
                  <code>{adminBag.legalEntityId ?? '— (flow picks the first GP-enabled one)'}</code>
                </dd>
                <dt>GP legal entities</dt>
                <dd>{adminBag.legalEntities.length}</dd>
                <dt>employment ID</dt>
                <dd>
                  <code>{adminBag.employmentId ?? '— (created on the country step)'}</code>
                </dd>
                <dt>isComplete</dt>
                <dd>{String(adminBag.isComplete)}</dd>
              </dl>
              <p className="subtle">
                Raw onboarding steps from <code>GET /v1/employments/&#123;id&#125;/onboarding-steps</code>:
              </p>
              <pre>{JSON.stringify(adminBag.apiSteps ?? null, null, 2)}</pre>
            </details>
          </>
        );
      }}
    />
  );
}

export function AdminFlowPage(props: Props) {
  const flow = <AdminFlow {...props} />;

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Admin onboarding</h2>
      <p className="subtle">
        Creates a GP employment for company <code>{COMPANY_ID}</code> and invites the
        employee. In proxy mode every call here goes out on the admin token.
      </p>
      {AUTH_MODE === 'direct' ? (
        <DirectAuthProvider tokenUrl="/local/token/admin">{flow}</DirectAuthProvider>
      ) : (
        <ProxyProvider>{flow}</ProxyProvider>
      )}
    </div>
  );
}
