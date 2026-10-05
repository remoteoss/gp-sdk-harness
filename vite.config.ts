import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Same-origin from the browser's point of view, so the SDK's absolute
      // proxy URL (`${window.location.origin}/api`) never leaves localhost:5173
      // and there is no CORS in Mode B.
      '/api': 'http://localhost:3001',
      '/local': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
    },
  },
});
