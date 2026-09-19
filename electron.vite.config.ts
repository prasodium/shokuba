import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// Some parent processes (other Electron apps' terminals) leak this variable, which turns
// Electron into plain Node so the app never starts. Clear it before electron-vite spawns Electron.
delete process.env['ELECTRON_RUN_AS_NODE']

const alias = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias },
    plugins: [react()],
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
})
