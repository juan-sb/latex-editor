"""Diff rasterizado página a página de dos PDF: comparar-pdf.py <a.pdf> <b.pdf> [dpi] [carpeta de salida].

Rasteriza los dos con pdftoppm (MiKTeX lo trae) al mismo DPI y compara los bytes de cada página. Imprime cuántas páginas difieren
y, de cada una, cuántos píxeles cambian, cuántos cambian fuerte (algún canal más de 100 de 255) y el rectángulo que los contiene.
Es lo que se usó en el spike S5 (docs/spikes/S5.md) y en la aceptación de F7 (scripts/aceptacion-f7.ps1).

Sale con 0 si los dos PDF son idénticos como imagen, 1 si hay diferencias y 2 si no se pudo rasterizar. Sin dependencias: sólo la
biblioteca estándar (los PPM se leen a mano).
"""
import os
import subprocess
import sys
import tempfile


def leer_ppm(ruta):
    datos = open(ruta, "rb").read()
    partes = datos.split(None, 4)
    ancho, alto = int(partes[1]), int(partes[2])
    return ancho, alto, datos[len(datos) - ancho * alto * 3:]


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    a, b = sys.argv[1], sys.argv[2]
    dpi = sys.argv[3] if len(sys.argv) > 3 else "60"
    salida = sys.argv[4] if len(sys.argv) > 4 else tempfile.mkdtemp(prefix="comparar-pdf-")
    carpetas = {}
    procesos = []
    for nombre, pdf in (("a", a), ("b", b)):
        carpeta = os.path.join(salida, nombre)
        os.makedirs(carpeta, exist_ok=True)
        for f in os.listdir(carpeta):
            os.remove(os.path.join(carpeta, f))
        carpetas[nombre] = carpeta
        procesos.append(subprocess.Popen(["pdftoppm", "-r", dpi, pdf, os.path.join(carpeta, "p")]))
    if any(p.wait() != 0 for p in procesos):
        print("pdftoppm falló")
        return 2
    pa, pb = sorted(os.listdir(carpetas["a"])), sorted(os.listdir(carpetas["b"]))
    print(f"páginas: a={len(pa)} b={len(pb)}")
    distintas = []
    for fa, fb in zip(pa, pb):
        wa, ha, da = leer_ppm(os.path.join(carpetas["a"], fa))
        wb, hb, db = leer_ppm(os.path.join(carpetas["b"], fb))
        if da == db:
            continue
        if (wa, ha) != (wb, hb):
            distintas.append((fa, "tamaño distinto", 0, 0, None))
            continue
        n = fuertes = 0
        x0, y0, x1, y1 = wa, ha, -1, -1
        for y in range(ha):
            fila_a, fila_b = da[y * wa * 3:(y + 1) * wa * 3], db[y * wa * 3:(y + 1) * wa * 3]
            if fila_a == fila_b:
                continue
            for x in range(wa):
                i = x * 3
                if fila_a[i:i + 3] != fila_b[i:i + 3]:
                    m = max(abs(fila_a[i + k] - fila_b[i + k]) for k in range(3))
                    n += 1
                    fuertes += m > 100
                    x0, x1, y0, y1 = min(x0, x), max(x1, x), min(y0, y), max(y1, y)
        distintas.append((fa, "píxeles", n, fuertes, (x0, y0, x1, y1)))
    print(f"páginas distintas: {len(distintas)}")
    for fa, que, n, fuertes, caja in distintas[:40]:
        print(f"  {fa}: {n} px, {fuertes} fuertes, caja {caja}" if caja else f"  {fa}: {que}")
    return 0 if len(pa) == len(pb) and not distintas else 1


if __name__ == "__main__":
    sys.exit(main())
