import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { cargarTema } from './store/tema';
import './styles.css';

// El tema se lee antes de pintar: sin esto la app aparece un instante con el claro aunque se haya elegido el oscuro.
void cargarTema().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
