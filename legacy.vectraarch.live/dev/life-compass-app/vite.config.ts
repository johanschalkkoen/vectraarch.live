import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron'

const webOnly = process.env.ELECTRON_NO_LAUNCH === '1'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ...(webOnly
      ? []
      : [
          electron([
            {
              entry: 'electron/main.js',
            },
          ]),
        ]),
  ],
})
