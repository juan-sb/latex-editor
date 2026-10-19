import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// base relativa: Tauri sirve el build con su propio protocolo, no desde la raíz de un servidor. El puerto de dev es fijo
// porque `tauri.conf.json` apunta a él.
export default defineConfig({
  plugins: [react()],
  base: './',
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'esnext', outDir: 'dist', emptyOutDir: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
