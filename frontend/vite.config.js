import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// Vercel hosts the dashboard (app.balloonsbuzz.com) and the API (api.balloonsbuzz.com) separately.
// Everywhere else (dev, Docker/nginx) /api is served from the same address.
if (process.env.VERCEL && !process.env.VITE_API_URL) process.env.VITE_API_URL = 'https://api.balloonsbuzz.com';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    // Same-origin in dev too, so SameSite=Strict cookies work exactly like production behind nginx.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: false } },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: false,
  },
});
