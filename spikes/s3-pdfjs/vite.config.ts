import { defineConfig } from 'vite';

// base relativa: Tauri sirve el build desde su propio protocolo, no desde la raíz de un servidor.
export default defineConfig({
  base: './',
  clearScreen: false,
  build: { target: 'esnext', outDir: 'dist', emptyOutDir: true },
});
