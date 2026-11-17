import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // The browser only ever talks to :5173, so cookies and requests are same-origin.
    proxy: {
      '/api': API,
      '/socket.io': { target: API, ws: true },
    },
  },
  build: {
    target: 'es2022',
  },
});
