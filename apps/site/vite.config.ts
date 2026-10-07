import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Preview builds intentionally identify the official public site as canonical.
// Metadata lives in index.html; injecting it again created duplicate OG images.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 4174 },
  preview: { host: '127.0.0.1', port: 4174 },
});
