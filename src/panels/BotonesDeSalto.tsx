// Los dos botones de salto entre el editor y el PDF (→ a la selección en el PDF, ← a la selección en el código), apilados sobre la
// barra que separa los dos paneles, como en Overleaf. Son hijos del `PanelResizeHandle`.
//
// Apretarlos no puede empezar un arrastre de la barra, y frenar el evento en el botón NO alcanza: react-resizable-panels (2.1.9) no usa
// los eventos del handle sino `pointerdown` en la fase de captura sobre el `body`, y decide por geometría si el puntero está sobre una
// barra. Se probó con `stopPropagation` y el smoke de F8c mostró que la barra se activaba igual. Por eso mientras el puntero está sobre
// los botones se avisa para que la barra se deshabilite (`disabled`), y vuelve a andar al salir. Con un botón del mouse apretado no se
// avisa: si se está arrastrando la barra y el puntero cruza los botones, el arrastre sigue.
import type { PointerEvent, SyntheticEvent } from 'react';
import { useApp } from '../store/app';

/** `mousedown` con `preventDefault`: el botón no le roba el foco al editor ni deshace la selección del texto del PDF. */
function sinFoco(e: SyntheticEvent) {
  e.stopPropagation();
  if (e.type === 'mousedown') e.preventDefault();
}

export function BotonesDeSalto({ alEntrar }: { alEntrar?: (encima: boolean) => void }) {
  const irAlPdf = useApp((s) => s.irAlPdf);
  const irAlCodigo = useApp((s) => s.irAlCodigo);
  const hayPdf = useApp((s) => s.pdfRel !== null && s.pdfEpoch > 0);
  const enFragmento = useApp((s) => s.vistaPdf === 'fragmento');
  const hayProyecto = useApp((s) => s.project !== null);
  const manejo = { onMouseDown: sinFoco, onPointerDown: sinFoco, onTouchStart: sinFoco };
  return (
    <div
      className="asa-sync"
      data-testid="botones-salto"
      onPointerEnter={(e: PointerEvent) => {
        if (e.buttons === 0) alEntrar?.(true);
      }}
      onPointerLeave={() => alEntrar?.(false)}
    >
      <button
        {...manejo}
        className="asa-salto"
        data-salto="pdf"
        disabled={!hayProyecto || !hayPdf || enFragmento}
        onClick={() => void irAlPdf()}
        title="Ir a la selección en el PDF (Ctrl+Alt+J)"
        aria-label="Ir a la selección en el PDF"
      >
        ▶
      </button>
      <button
        {...manejo}
        className="asa-salto"
        data-salto="codigo"
        disabled={!hayPdf || enFragmento}
        onClick={() => void irAlCodigo()}
        title="Ir a la selección en el código (el texto elegido en el PDF, o el centro de lo que se ve)"
        aria-label="Ir a la selección en el código"
      >
        ◀
      </button>
    </div>
  );
}
