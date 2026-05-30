import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4000'
    }
  },
  build: {
    outDir: 'dist'
  },
  define: {
    // Fallback to 'dev' when VITE_APP_VERSION is not injected at build time
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(
      process.env.VITE_APP_VERSION || 'dev'
    )
  }
})
