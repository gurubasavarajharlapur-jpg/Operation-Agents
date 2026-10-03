import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the dashboard calls /api/..., and Vite forwards it to the Fastify API,
// so the browser sees one origin and no CORS setup is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.API_PORT ?? 3000}`,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
