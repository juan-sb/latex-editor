"""Compara dos latexviewer.json como la app los entiende: los valores por omisión de cada perfil no cuentan (el que escribe la app los
omite y el que se escribe a mano los pone), y la etiqueta de una variable tampoco (no se puede deducir de los textos del proyecto).

Uso:  python scripts/comparar-config.py escrito.json esperado.json
Sale con 0 si son equivalentes; si no, imprime las diferencias y sale con 1.
"""
import json
import sys

PERFIL_POR_OMISION = {
    "partial": False,
    "externalize": False,
    "cacheOnly": False,
    "parts": "all",
    "cleanBefore": False,
    "autoCompile": True,
    "hidden": False,
    "draftImages": False,
}


def normalizar(c):
    c = json.loads(json.dumps(c))
    c.setdefault("engine", "pdflatex")
    c.setdefault("parts", {}).setdefault("commands", ["include"])
    f = c.setdefault("flags", {})
    for k in ("partial", "externalize", "figureList"):
        f.setdefault(k, [])
    for p in c.get("profiles", {}).values():
        for k, v in PERFIL_POR_OMISION.items():
            p.setdefault(k, v)
    for v in c.get("variables", {}).values():
        v.pop("label", None)
    return c


def diferencias(a, b, ruta=""):
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append(f"{ruta}/{k}: falta en lo escrito (esperado {json.dumps(b[k], ensure_ascii=False)})")
            elif k not in b:
                out.append(f"{ruta}/{k}: sobra en lo escrito ({json.dumps(a[k], ensure_ascii=False)})")
            else:
                out += diferencias(a[k], b[k], f"{ruta}/{k}")
        return out
    return [] if a == b else [f"{ruta}: escrito {json.dumps(a, ensure_ascii=False)} y esperado {json.dumps(b, ensure_ascii=False)}"]


def leer(ruta):
    with open(ruta, encoding="utf-8-sig") as f:
        return json.load(f)


if __name__ == "__main__":
    d = diferencias(normalizar(leer(sys.argv[1])), normalizar(leer(sys.argv[2])))
    if d:
        print("\n".join(d))
        sys.exit(1)
    print("equivalentes")
