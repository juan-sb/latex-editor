// Buffer del log crudo del build. Recibe fragmentos de texto (no líneas): pdflatex escribe `[12] [13]...` sin saltos de
// línea durante mucho tiempo, y la línea a medias tiene que seguir creciendo con el fragmento siguiente.
// Es un módulo puro (sin React ni Tauri) para poder probarlo.

export class LogBuffer {
  /** La última es la línea en curso, todavía sin salto. */
  private lines: string[] = [''];
  private version = 0;
  private descartadas = 0;
  private readonly oyentes = new Set<() => void>();

  constructor(private readonly maximo = 50_000) {}

  append(texto: string): void {
    if (!texto) return;
    // Un CRLF partido entre dos fragmentos ("...\r" y "\n...") no tiene que dejar un \r colgado en la línea.
    if (texto.startsWith('\n') && this.lines[this.lines.length - 1].endsWith('\r')) {
      this.lines[this.lines.length - 1] = this.lines[this.lines.length - 1].slice(0, -1);
    }
    const partes = texto.split(/\r?\n/);
    this.lines[this.lines.length - 1] += partes[0];
    for (let i = 1; i < partes.length; i++) this.lines.push(partes[i]);
    // Se recorta de a bloques (10 % de margen): recortar en cada fragmento sería cuadrático con un log de 50 mil líneas.
    if (this.lines.length > this.maximo * 1.1) {
      const sobran = this.lines.length - this.maximo;
      this.lines.splice(0, sobran);
      this.descartadas += sobran;
    }
    this.avisar();
  }

  clear(): void {
    this.lines = [''];
    this.descartadas = 0;
    this.avisar();
  }

  get length(): number {
    return this.lines.length;
  }

  /** Cuántas líneas viejas se tiraron por el tope. */
  get lineasDescartadas(): number {
    return this.descartadas;
  }

  slice(desde: number, hasta: number): string[] {
    return this.lines.slice(desde, hasta);
  }

  /** Para `useSyncExternalStore`: cambia con cada modificación. */
  getVersion = (): number => this.version;

  subscribe = (cb: () => void): (() => void) => {
    this.oyentes.add(cb);
    return () => {
      this.oyentes.delete(cb);
    };
  };

  private avisar(): void {
    this.version++;
    this.oyentes.forEach((cb) => cb());
  }
}

/** El log del build en curso: uno solo por aplicación. */
export const logBuffer = new LogBuffer();
