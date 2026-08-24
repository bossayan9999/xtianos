import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const API_TARGET = 'http://localhost:3101'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': API_TARGET,
      '/health': API_TARGET,
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
})
