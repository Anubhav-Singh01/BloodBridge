import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The backend's CORS allow-list is built from FRONTEND_URL (http://localhost:5173), so the dev
    // server must not silently move to another port. If 5173 is busy, fail instead.
    port: 5173,
    strictPort: true,
  },
})
