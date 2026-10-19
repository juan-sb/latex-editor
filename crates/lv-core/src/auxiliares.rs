//! Aislamiento de los auxiliares por perfil (opción A de S1, 5.4 y 5.5 del plan).
//!
//! Cada perfil compila en `.lv/build/<perfil>/`. Lo que hace falta alrededor de latexmk, todo medido en S1:
//! - **Sembrado:** con `\includeonly`, LaTeX saca de los `.aux` las referencias de las partes que no entran. Antes de un
//!   build parcial se copia el `.aux` de cada parte excluida desde el build de otro perfil que lo tenga más nuevo, y sólo
//!   si el contenido difiere (así no se toca el mtime de lo que ya es igual y no se provocan pasadas).
//! - **Sospechoso:** un build que falló o se cortó puede dejar un `.aux` truncado, y sembrar desde ahí lo propaga (S1,
//!   etapa kill). El marcador se pone **antes** de compilar y se saca sólo cuando el build sale bien: así sobrevive a un
//!   cierre brusco de la app, que es justo cuando hace falta.
//! - **`.md5` de pgf:** con `-output-directory` pgf escribe el `.md5` de una figura en el directorio del perfil, y el otro
//!   perfil, que lee el de `figuras-cache/`, lo ve viejo y recocina la figura (23,8 s en vez de 9,4 s). Se mueven al cache
//!   compartido después de cada build.
//! - **Reparación:** borrar los auxiliares del perfil deja sano un `.aux` truncado (cuesta un build en frío de `.aux`).

use crate::error::{Error, Result};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub fn build_dir(root: &Path, perfil: &str) -> PathBuf {
    root.join(".lv").join("build").join(perfil)
}

fn marcador(root: &Path, perfil: &str) -> PathBuf {
    build_dir(root, perfil).join(".sospechoso")
}

pub fn is_suspect(root: &Path, perfil: &str) -> bool {
    marcador(root, perfil).exists()
}

pub fn mark_suspect(root: &Path, perfil: &str) -> Result<()> {
    let dir = build_dir(root, perfil);
    fs::create_dir_all(&dir).map_err(|e| Error::Io(format!("{}: {e}", dir.display())))?;
    fs::write(marcador(root, perfil), "el último build de este perfil no terminó bien: sus .aux no se siembran\n")
        .map_err(|e| Error::Io(format!("{}: {e}", marcador(root, perfil).display())))
}

pub fn clear_suspect(root: &Path, perfil: &str) {
    let _ = fs::remove_file(marcador(root, perfil));
}

/// Crea dentro del directorio del perfil las carpetas donde `\include` escribe sus `.aux`.
pub fn ensure_include_dirs(root: &Path, perfil: &str, dirs: &BTreeSet<String>) -> Result<()> {
    let base = build_dir(root, perfil);
    fs::create_dir_all(&base).map_err(|e| Error::Io(format!("{}: {e}", base.display())))?;
    for d in dirs {
        let p = base.join(d);
        fs::create_dir_all(&p).map_err(|e| Error::Io(format!("{}: {e}", p.display())))?;
    }
    Ok(())
}

/// Crea las dos carpetas del cache de figuras: `<cache>/` en la raíz (donde pgf deja los PDF) y `.lv/build/<perfil>/<cache>/`
/// (donde deja los `.md5`). MiKTeX las crea solo; **TeX Live no**, y sin ellas el primer build que externaliza falla con
/// `I can't write on file '<cache>/....md5'` y `Emergency stop` (revisión previa a F6, probado con TeX Live 2022).
pub fn ensure_cache_dirs(root: &Path, perfil: &str, cache_dir: &str) -> Result<()> {
    for d in [root.join(cache_dir), build_dir(root, perfil).join(cache_dir)] {
        fs::create_dir_all(&d).map_err(|e| Error::Io(format!("{}: {e}", d.display())))?;
    }
    Ok(())
}

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// Copia `de` a `a` sólo si el contenido difiere. Devuelve si copió.
fn copiar_si_difiere(de: &Path, a: &Path) -> std::io::Result<bool> {
    if let Some(dir) = a.parent() {
        fs::create_dir_all(dir)?;
    }
    if a.exists() && fs::read(de)? == fs::read(a)? {
        return Ok(false);
    }
    fs::copy(de, a)?;
    Ok(true)
}

/// Siembra en `destino` el `.aux` de cada parte de `excluidas` desde el perfil de `fuentes` que lo tenga más nuevo y no
/// sea sospechoso. Devuelve cuántos copió.
pub fn seed(root: &Path, destino: &str, excluidas: &[String], fuentes: &[String]) -> Result<usize> {
    let buenas: Vec<&String> = fuentes.iter().filter(|f| f.as_str() != destino && !is_suspect(root, f)).collect();
    let dest_dir = build_dir(root, destino);
    let mut copiados = 0;
    for parte in excluidas {
        let rel = format!("{parte}.aux");
        let propio = dest_dir.join(&rel);
        let propio_mtime = mtime(&propio);
        // El más nuevo de los que lo tienen.
        let mejor = buenas
            .iter()
            .map(|f| build_dir(root, f).join(&rel))
            .filter_map(|p| mtime(&p).map(|m| (m, p)))
            .max_by_key(|(m, _)| *m);
        let Some((m, origen)) = mejor else { continue };
        if propio_mtime.is_some_and(|p| p >= m) {
            continue;
        }
        if copiar_si_difiere(&origen, &propio).map_err(|e| Error::Io(format!("sembrar {rel}: {e}")))? {
            copiados += 1;
        }
    }
    Ok(copiados)
}

/// Mueve los `.md5` que pgf dejó en `.lv/build/<perfil>/<cache>` al cache compartido de la raíz. Devuelve cuántos.
///
/// Con `rename`: es atómico (nadie ve un `.md5` a medio escribir) y mantiene el contenido y la fecha; copiar y borrar
/// dejaba un instante con dos copias, y en Linux `fs::copy` no conserva el mtime. Si no se puede (el cache en otra unidad)
/// cae a copiar y borrar.
pub fn move_md5(root: &Path, perfil: &str, cache_dir: &str) -> usize {
    let origen = build_dir(root, perfil).join(cache_dir);
    let Ok(rd) = fs::read_dir(&origen) else { return 0 };
    let destino = root.join(cache_dir);
    let mut n = 0;
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().is_some_and(|x| x == "md5") && fs::create_dir_all(&destino).is_ok() {
            let a = destino.join(e.file_name());
            if fs::rename(&p, &a).is_ok() || (fs::copy(&p, &a).is_ok() && fs::remove_file(&p).is_ok()) {
                n += 1;
            }
        }
    }
    n
}

const AUXILIARES: [&str; 17] = [
    "aux", "out", "toc", "lof", "lot", "bbl", "bcf", "blg", "idx", "ind", "ilg", "fdb_latexmk", "fls", "auxlock", "xdv", "nav", "snm",
];

fn es_auxiliar(p: &Path) -> bool {
    let nombre = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    nombre.ends_with(".run.xml") || p.extension().is_some_and(|x| AUXILIARES.contains(&x.to_string_lossy().to_lowercase().as_str()))
}

/// Borra los auxiliares del perfil (no el PDF, ni el `.synctex.gz`, ni el log, ni el cache de figuras). Es la reparación
/// de 5.5 y también el "limpiar antes" del completo. Devuelve cuántos archivos borró.
pub fn clean_profile(root: &Path, perfil: &str, cache_dir: &str) -> usize {
    fn rec(dir: &Path, saltear: &Path, n: &mut usize) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if p != saltear {
                    rec(&p, saltear, n);
                }
            } else if es_auxiliar(&p) && fs::remove_file(&p).is_ok() {
                *n += 1;
            }
        }
    }
    let base = build_dir(root, perfil);
    let mut n = 0;
    rec(&base, &base.join(cache_dir), &mut n);
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn escribir(root: &Path, rel: &str, texto: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, texto).unwrap();
    }

    fn pausa() {
        std::thread::sleep(Duration::from_millis(30));
    }

    #[test]
    fn siembra_desde_el_mas_nuevo_y_no_toca_lo_que_ya_es_igual() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        escribir(r, ".lv/build/rapido/Secciones/Dos.aux", "viejo");
        pausa();
        escribir(r, ".lv/build/completo/Secciones/Dos.aux", "nuevo");
        let fuentes = vec!["rapido".to_string(), "completo".to_string(), "parcial".to_string()];
        let excl = vec!["Secciones/Dos".to_string(), "Secciones/Tres".to_string()];
        assert_eq!(seed(r, "parcial", &excl, &fuentes).unwrap(), 1, "Tres no existe en ninguno");
        assert_eq!(fs::read_to_string(r.join(".lv/build/parcial/Secciones/Dos.aux")).unwrap(), "nuevo");
        // Segunda vez: el propio ya es igual o más nuevo, no se copia (ni se toca su mtime).
        let m1 = mtime(&r.join(".lv/build/parcial/Secciones/Dos.aux"));
        pausa();
        assert_eq!(seed(r, "parcial", &excl, &fuentes).unwrap(), 0);
        assert_eq!(mtime(&r.join(".lv/build/parcial/Secciones/Dos.aux")), m1);
        // Un origen más nuevo pero con el mismo contenido tampoco provoca una copia.
        pausa();
        escribir(r, ".lv/build/rapido/Secciones/Dos.aux", "nuevo");
        assert_eq!(seed(r, "parcial", &excl, &fuentes).unwrap(), 0);
        assert_eq!(mtime(&r.join(".lv/build/parcial/Secciones/Dos.aux")), m1);
    }

    #[test]
    fn no_siembra_desde_un_build_sospechoso() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        escribir(r, ".lv/build/rapido/Secciones/Dos.aux", "truncado\\newlabel{");
        mark_suspect(r, "rapido").unwrap();
        assert!(is_suspect(r, "rapido"));
        let fuentes = vec!["rapido".to_string()];
        let excl = vec!["Secciones/Dos".to_string()];
        assert_eq!(seed(r, "parcial", &excl, &fuentes).unwrap(), 0);
        assert!(!r.join(".lv/build/parcial/Secciones/Dos.aux").exists());
        clear_suspect(r, "rapido");
        assert_eq!(seed(r, "parcial", &excl, &fuentes).unwrap(), 1, "un build bueno vuelve a ser origen válido");
    }

    #[test]
    fn el_perfil_no_se_siembra_a_si_mismo() {
        let d = tempfile::tempdir().unwrap();
        escribir(d.path(), ".lv/build/parcial/x.aux", "a");
        assert_eq!(seed(d.path(), "parcial", &["x".to_string()], &["parcial".to_string()]).unwrap(), 0);
    }

    #[test]
    fn mueve_los_md5_al_cache_compartido_y_no_toca_los_pdf() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        escribir(r, ".lv/build/parcial/figuras-cache/A-uno-0.md5", "nuevo");
        escribir(r, ".lv/build/parcial/figuras-cache/A-uno-0.log", "log");
        escribir(r, "figuras-cache/A-uno-0.md5", "viejo");
        assert_eq!(move_md5(r, "parcial", "figuras-cache"), 1);
        assert_eq!(fs::read_to_string(r.join("figuras-cache/A-uno-0.md5")).unwrap(), "nuevo");
        assert!(!r.join(".lv/build/parcial/figuras-cache/A-uno-0.md5").exists());
        assert!(r.join(".lv/build/parcial/figuras-cache/A-uno-0.log").exists());
        assert_eq!(move_md5(r, "parcial", "figuras-cache"), 0);
        assert_eq!(move_md5(r, "no-hay", "figuras-cache"), 0);
    }

    #[test]
    fn la_reparacion_borra_los_auxiliares_y_deja_el_pdf_el_log_y_el_cache() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        for f in [
            "lv-rapido.aux", "lv-rapido.fdb_latexmk", "lv-rapido.out", "lv-rapido.toc", "lv-rapido.run.xml", "Secciones/Dos.aux", "Capítulos/Desarrollo/Tres.aux",
        ] {
            escribir(r, &format!(".lv/build/rapido/{f}"), "x");
        }
        for f in ["lv-rapido.pdf", "lv-rapido.synctex.gz", "lv-rapido.log", "figuras-cache/A-0.aux"] {
            escribir(r, &format!(".lv/build/rapido/{f}"), "x");
        }
        mark_suspect(r, "rapido").unwrap();
        assert_eq!(clean_profile(r, "rapido", "figuras-cache"), 7);
        for f in ["lv-rapido.pdf", "lv-rapido.synctex.gz", "lv-rapido.log", "figuras-cache/A-0.aux"] {
            assert!(r.join(".lv/build/rapido").join(f).exists(), "{f} no se borra");
        }
        assert!(is_suspect(r, "rapido"), "limpiar no cambia el estado: lo decide el build que sigue");
        assert_eq!(clean_profile(r, "no-hay", "figuras-cache"), 0);
    }

    #[test]
    fn el_md5_movido_conserva_contenido_y_fecha_y_no_deja_copia() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        escribir(r, ".lv/build/rapido/figuras-cache/B-dos-1.md5", "contenido");
        let antes = mtime(&r.join(".lv/build/rapido/figuras-cache/B-dos-1.md5")).unwrap();
        assert_eq!(move_md5(r, "rapido", "figuras-cache"), 1);
        assert_eq!(fs::read_to_string(r.join("figuras-cache/B-dos-1.md5")).unwrap(), "contenido");
        assert_eq!(mtime(&r.join("figuras-cache/B-dos-1.md5")).unwrap(), antes, "rename conserva la fecha");
        assert!(!r.join(".lv/build/rapido/figuras-cache/B-dos-1.md5").exists());
    }

    #[test]
    fn crea_las_dos_carpetas_del_cache_aunque_ya_existan() {
        let d = tempfile::tempdir().unwrap();
        ensure_cache_dirs(d.path(), "rapido", "figuras-cache").unwrap();
        assert!(d.path().join("figuras-cache").is_dir());
        assert!(d.path().join(".lv/build/rapido/figuras-cache").is_dir());
        ensure_cache_dirs(d.path(), "rapido", "figuras-cache").unwrap();
        ensure_cache_dirs(d.path(), "parcial", "img/cache").unwrap();
        assert!(d.path().join("img/cache").is_dir() && d.path().join(".lv/build/parcial/img/cache").is_dir());
    }

    #[test]
    fn crea_las_carpetas_de_include_dentro_del_perfil() {
        let d = tempfile::tempdir().unwrap();
        let dirs: BTreeSet<String> = ["Capítulos".to_string(), "Capítulos/Desarrollo".to_string()].into();
        ensure_include_dirs(d.path(), "rapido", &dirs).unwrap();
        assert!(d.path().join(".lv/build/rapido/Capítulos/Desarrollo").is_dir());
    }
}
