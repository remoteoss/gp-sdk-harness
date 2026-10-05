import { useState } from 'react';

import { AdminFlowPage } from './AdminFlowPage';
import { EmployeeFlowPage } from './EmployeeFlowPage';
import { AUTH_MODE } from './providers';

type Tab = 'admin' | 'employee';

export default function App() {
  const [tab, setTab] = useState<Tab>('admin');
  const [employmentId, setEmploymentId] = useState('');

  return (
    <div className="harness">
      <h1>GP SDK harness</h1>
      <p className="subtle">
        @remoteoss/remote-flows 1.58.0 · partners sandbox ·{' '}
        {AUTH_MODE === 'direct' ? (
          <strong>Mode A — direct auth, tokens in the browser</strong>
        ) : (
          <>Mode B — one-rule proxy, no tokens in the browser</>
        )}
      </p>

      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'admin'}
          onClick={() => setTab('admin')}
        >
          Admin flow
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'employee'}
          onClick={() => setTab('employee')}
        >
          Employee flow
        </button>
      </div>

      {/* Both pages stay mounted so switching tabs mid-flow doesn't reset the
          SDK's step state and re-fetch everything. */}
      <div hidden={tab !== 'admin'}>
        <AdminFlowPage
          onEmploymentCreated={setEmploymentId}
          onOpenEmployeeTab={() => setTab('employee')}
        />
      </div>
      <div hidden={tab !== 'employee'}>
        <EmployeeFlowPage employmentId={employmentId} setEmploymentId={setEmploymentId} />
      </div>
    </div>
  );
}
