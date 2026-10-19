// Punto único de acceso al backend. Los tests inyectan uno simulado con `setBackend`.
import { tauriBackend } from './tauri';
import type { Backend } from './types';

let actual: Backend = tauriBackend;

export const getBackend = (): Backend => actual;
export const setBackend = (b: Backend): void => {
  actual = b;
};

export * from './types';
