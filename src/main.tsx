import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@remoteoss/remote-flows/styles.css';
import './harness.css';

import App from './App';
import { installRequestLog } from './requestLog';

// Mode A has no proxy, so the proxy log cannot record anything. Patch fetch
// before the SDK loads so every gateway call is captured. No-op in Mode B.
if (import.meta.env.VITE_AUTH_MODE === 'direct') installRequestLog();

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
