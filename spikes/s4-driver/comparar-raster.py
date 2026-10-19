"""Compara dos PDF página a página, rasterizados (pdftoppm) y con diff de imágenes.

Es la prueba de equivalencia que pide plan.md para F9 ("rasterizado + diff de imágenes"). El texto
extraído con pdftotext no sirve para esto: reordena líneas de ecuaciones y figuras sin que el
contenido cambie (en S4 dio 31 de 48 páginas "distintas" con el layout idéntico).

Uso: python -I comparar-raster.py <a.pdf> <b.pdf> <carpeta-temporal> [dpi]
Sale con 0 si ninguna página supera el umbral, 1 si alguna lo supera.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

UMBRAL_NIVEL = 48         # diferencia de gris (0 a 255) para contar un píxel como distinto
# Fracción de píxeles distintos a partir de la cual se marca la página. En S4, lv-parcial (figuras
# dibujadas en línea) contra cap_actual (figuras externalizadas) dio 0,006 % de media y 0,23 % en la
# peor página, que a ojo es el rayado de una zona y una línea de texto corridos menos de un píxel.
UMBRAL_FRACCION = 0.005


def rasterizar(pdf: Path, destino: Path, dpi: int) -> list[Path]:
    destino.mkdir(parents=True, exist_ok=True)
    for viejo in destino.glob("p-*.png"):
        viejo.unlink()
    subprocess.run(["pdftoppm", "-r", str(dpi), "-gray", "-png", str(pdf), str(destino / "p")], check=True)
    return sorted(destino.glob("p-*.png"))


def main() -> int:
    a, b, tmp = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    dpi = int(sys.argv[4]) if len(sys.argv) > 4 else 60
    pa = rasterizar(a, tmp / "a", dpi)
    pb = rasterizar(b, tmp / "b", dpi)
    print(f"páginas: {a.name}={len(pa)}  {b.name}={len(pb)}  ({dpi} dpi)")
    if len(pa) != len(pb):
        print("distinta cantidad de páginas")
        return 1
    filas = []
    for i, (x, y) in enumerate(zip(pa, pb), start=1):
        ia = np.asarray(Image.open(x), dtype=np.int16)
        ib = np.asarray(Image.open(y), dtype=np.int16)
        if ia.shape != ib.shape:
            filas.append((i, 1.0, 255))
            continue
        d = np.abs(ia - ib)
        filas.append((i, float((d > UMBRAL_NIVEL).mean()), int(d.max())))
    malas = [f for f in filas if f[1] > UMBRAL_FRACCION]
    fr = np.array([f[1] for f in filas])
    print(f"fracción de píxeles distintos: media {fr.mean():.5f}  máxima {fr.max():.5f}")
    print(f"páginas sobre el umbral ({UMBRAL_FRACCION}): {len(malas)} de {len(filas)}")
    for pag, frac, mx in sorted(malas, key=lambda f: -f[1])[:10]:
        print(f"  página {pag}: {frac:.5f} de píxeles distintos, diferencia máxima {mx}")
    return 1 if malas else 0


if __name__ == "__main__":
    sys.exit(main())
