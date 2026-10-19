import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// /v1 is proxied same-origin to the API (avoids an Authorization preflight); the
// browser tests point it at an in-process server on a free port instead
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: { '/v1': 'http://127.0.0.1:8788' },
  },
});
