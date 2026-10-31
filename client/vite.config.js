// vite.config.js - configuration of Vite, the development server and build tool of the React client.
//
// Helper that gives the configuration object editor auto-completion.
import { defineConfig } from 'vite';
// Vite plugin for React: compiles JSX and reloads changed components without losing their state (fast refresh).
import react from '@vitejs/plugin-react';

// The configuration Vite reads for `npm run dev` and `npm run build`.
export default defineConfig({
  // Activate the React plugin.
  plugins: [react()],
  // Settings of the development server (npm run dev).
  server: {
    // The React app runs on http://localhost:5173.
    port: 5173,
    // forward API calls to the Express server during development
    proxy: { '/api': 'http://localhost:3001' },
  },
});
