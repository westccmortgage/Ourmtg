import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// SPA build. In `netlify dev` the functions are proxied at /.netlify/functions/* on the
// same origin, so no dev proxy config is needed there. For plain `vite dev` against a
// remote gateway, set VITE_API_BASE to the deployed functions base URL.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
})
