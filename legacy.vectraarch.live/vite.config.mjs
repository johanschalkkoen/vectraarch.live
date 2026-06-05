import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Legacy SPA build. The app shell (index.html) and its single entry (src/main.jsx)
// are bundled here; everything under absolute paths (/auth-guard.js, /trial-banner.js,
// /shared, /images, /api) is served by the Express backend at runtime, so we leave
// those references untouched and only emit the hashed app bundle into dist/.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
