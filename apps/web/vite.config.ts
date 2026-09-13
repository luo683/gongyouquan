import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev-time proxy so the browser talks to same-origin /api and /socket.io and the
 * backend never has to reason about CORS in development. The target is an env
 * var because the compose stack runs the API under a different hostname than a
 * laptop does.
 */
export default defineConfig(() => {
  const api = process.env.VITE_DEV_API_ORIGIN ?? 'http://127.0.0.1:3000';
  return {
    plugins: [react()],
    server: {
      port: Number(process.env.VITE_DEV_PORT ?? 5173),
      proxy: {
        '/api': { target: api, changeOrigin: false },
        '/socket.io': { target: api, ws: true, changeOrigin: false },
      },
    },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
  } as ReturnType<typeof defineConfig>;
});
