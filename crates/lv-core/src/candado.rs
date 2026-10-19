//! Candado por proyecto (5.6 del plan, F8). Dos instancias de la app sobre el mismo proyecto tendrían dos colas escribiendo el mismo
//! `.lv/` y el mismo cache de figuras: se pisarían los auxiliares, los `.md5` y los PDF de las figuras. La primera en abrirlo toma
//! `.lv/lock` con su PID; la segunda lo ve y trabaja sin compilar ni cocinar (la edición sigue andando), y lo avisa.
//!
//! Un cierre brusco (matar la app, cortar la luz) no puede dejar el proyecto trabado para siempre: el candado que ya existe sólo vale
//! si el proceso de su PID sigue **vivo y es la app** (el nombre del ejecutable). Un PID que ya no existe, o que otro programa heredó, se
//! toma. El candado propio se reconoce por su PID (un cambio de proyecto dentro de la misma instancia no se bloquea a sí mismo) y se
//! suelta al cerrar la sesión, pero sólo si el archivo sigue siendo el de esta sesión (un `token` propio).

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const LOCK_FILE: &str = ".lv/lock";

#[derive(Debug, Serialize, Deserialize)]
struct Contenido {
    pid: u32,
    /// El ejecutable de quien lo tomó, para que quien lo lea sepa de qué programa es el PID.
    app: String,
    token: u64,
    desde_ms: u64,
}

/// Qué hacer con un candado que ya existe.
#[derive(Debug, PartialEq, Eq)]
pub enum Veredicto {
    /// Lo tiene otra instancia viva de la app.
    Ocupado(u32),
    /// Se puede tomar: ilegible, propio, de un proceso que ya no existe o de otro programa.
    Libre,
}

/// El nombre del ejecutable de la app (en minúsculas). `LV_NOMBRE_APP` lo reemplaza: sirve a las pruebas, que no pueden lanzar una
/// segunda `lv-app.exe`.
pub fn nombre_de_la_app() -> String {
    if let Ok(n) = std::env::var("LV_NOMBRE_APP") {
        if !n.trim().is_empty() {
            return n.trim().to_lowercase();
        }
    }
    std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase())).unwrap_or_else(|| "lv-app.exe".into())
}

/// El veredicto sobre el contenido de un candado existente. `imagen_de` dice cómo se llama el ejecutable de un PID vivo.
pub fn evaluar(contenido: &[u8], pid_propio: u32, app_esperada: &str, imagen_de: &dyn Fn(u32) -> Option<String>) -> Veredicto {
    let Ok(c) = serde_json::from_slice::<Contenido>(contenido) else { return Veredicto::Libre };
    if c.pid == 0 || c.pid == pid_propio {
        return Veredicto::Libre;
    }
    match imagen_de(c.pid) {
        Some(n) if n.eq_ignore_ascii_case(app_esperada) => Veredicto::Ocupado(c.pid),
        _ => Veredicto::Libre,
    }
}

/// El candado tomado por esta sesión. Al soltarlo se borra el archivo si sigue siendo el suyo.
#[derive(Debug)]
pub struct Candado {
    path: PathBuf,
    token: u64,
}

pub enum Adquirido {
    Tomado(Candado),
    Ocupado(u32),
}

fn token() -> u64 {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    n ^ (u64::from(std::process::id()) << 32)
}

/// Toma el candado de `root` o dice quién lo tiene. Si no se puede escribir (carpeta de sólo lectura) no bloquea: sin dónde compilar
/// tampoco hay nada que pisar, y tener el proyecto abierto para leer no tiene por qué fallar.
pub fn adquirir(root: &Path) -> Adquirido {
    adquirir_con(root, std::process::id(), &nombre_de_la_app(), &crate::procs::imagen_de_proceso)
}

pub fn adquirir_con(root: &Path, pid: u32, app: &str, imagen_de: &dyn Fn(u32) -> Option<String>) -> Adquirido {
    let path = root.join(LOCK_FILE);
    let _ = fs::create_dir_all(root.join(".lv"));
    let token = token();
    let contenido = Contenido { pid, app: app.to_string(), token, desde_ms: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) };
    let texto = serde_json::to_vec_pretty(&contenido).unwrap_or_default();
    for _ in 0..3 {
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                let _ = f.write_all(&texto);
                return Adquirido::Tomado(Candado { path, token });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let actual = fs::read(&path).unwrap_or_default();
                match evaluar(&actual, pid, app, imagen_de) {
                    Veredicto::Ocupado(otro) => return Adquirido::Ocupado(otro),
                    // Viejo, ajeno o propio: se lo pisa (sin esperar: si dos lo hacen a la vez, uno de los dos `create_new` falla y
                    // vuelve a mirar quién quedó).
                    Veredicto::Libre => {
                        let _ = fs::remove_file(&path);
                    }
                }
            }
            Err(_) => return Adquirido::Tomado(Candado { path, token }),
        }
    }
    Adquirido::Tomado(Candado { path, token })
}

impl Drop for Candado {
    fn drop(&mut self) {
        if let Ok(b) = fs::read(&self.path) {
            if serde_json::from_slice::<Contenido>(&b).is_ok_and(|c| c.token == self.token) {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn escribir(root: &Path, c: &Contenido) {
        fs::create_dir_all(root.join(".lv")).unwrap();
        fs::write(root.join(LOCK_FILE), serde_json::to_vec(c).unwrap()).unwrap();
    }

    fn de(pid: u32) -> Contenido {
        Contenido { pid, app: "lv-app.exe".into(), token: 7, desde_ms: 1 }
    }

    #[test]
    fn el_veredicto_depende_de_que_el_proceso_este_vivo_y_sea_la_app() {
        let vivo = |pid: u32| match pid {
            100 => Some("lv-app.exe".to_string()),
            200 => Some("chrome.exe".to_string()),
            _ => None,
        };
        let j = |c: &Contenido| serde_json::to_vec(c).unwrap();
        assert_eq!(evaluar(&j(&de(100)), 1, "lv-app.exe", &vivo), Veredicto::Ocupado(100), "otra instancia viva de la app");
        assert_eq!(evaluar(&j(&de(100)), 100, "lv-app.exe", &vivo), Veredicto::Libre, "el candado propio no bloquea");
        assert_eq!(evaluar(&j(&de(300)), 1, "lv-app.exe", &vivo), Veredicto::Libre, "un PID que ya no existe: cierre brusco");
        assert_eq!(evaluar(&j(&de(200)), 1, "lv-app.exe", &vivo), Veredicto::Libre, "un PID que otro programa heredó");
        assert_eq!(evaluar(&j(&de(100)), 1, "LV-APP.EXE", &vivo), Veredicto::Ocupado(100), "las mayúsculas no cuentan");
        assert_eq!(evaluar(b"no es json", 1, "lv-app.exe", &vivo), Veredicto::Libre);
        assert_eq!(evaluar(b"", 1, "lv-app.exe", &vivo), Veredicto::Libre);
        assert_eq!(evaluar(&j(&de(0)), 1, "lv-app.exe", &vivo), Veredicto::Libre);
    }

    #[test]
    fn la_primera_instancia_toma_la_segunda_ve_quien_lo_tiene_y_soltar_deja_el_proyecto_libre() {
        let d = tempfile::tempdir().unwrap();
        let vivo = |pid: u32| (pid == 10).then(|| "lv-app.exe".to_string());
        let Adquirido::Tomado(c) = adquirir_con(d.path(), 10, "lv-app.exe", &vivo) else { panic!("tenía que tomarlo") };
        assert!(d.path().join(LOCK_FILE).is_file());
        let contenido: Contenido = serde_json::from_slice(&fs::read(d.path().join(LOCK_FILE)).unwrap()).unwrap();
        assert_eq!((contenido.pid, contenido.app.as_str()), (10, "lv-app.exe"));
        // Otra instancia (otro PID): ocupado.
        assert!(matches!(adquirir_con(d.path(), 20, "lv-app.exe", &vivo), Adquirido::Ocupado(10)));
        // La misma instancia otra vez (un cambio de proyecto adentro de la app): lo toma sin bloquearse a sí misma.
        let Adquirido::Tomado(c2) = adquirir_con(d.path(), 10, "lv-app.exe", &vivo) else { panic!("el propio no bloquea") };
        // Soltar el viejo no borra el candado de la sesión nueva (cada uno tiene su token).
        drop(c);
        assert!(d.path().join(LOCK_FILE).is_file());
        drop(c2);
        assert!(!d.path().join(LOCK_FILE).exists());
        assert!(matches!(adquirir_con(d.path(), 20, "lv-app.exe", &vivo), Adquirido::Tomado(_)), "libre otra vez");
    }

    #[test]
    fn un_candado_de_un_cierre_brusco_se_pisa() {
        let d = tempfile::tempdir().unwrap();
        escribir(d.path(), &de(555)); // nadie vive con ese PID
        let vivo = |_: u32| None;
        let Adquirido::Tomado(c) = adquirir_con(d.path(), 20, "lv-app.exe", &vivo) else { panic!("el candado viejo no vale") };
        let contenido: Contenido = serde_json::from_slice(&fs::read(d.path().join(LOCK_FILE)).unwrap()).unwrap();
        assert_eq!(contenido.pid, 20);
        drop(c);
        // Un archivo basura tampoco traba nada.
        fs::write(d.path().join(LOCK_FILE), b"\x00\x01 basura").unwrap();
        assert!(matches!(adquirir_con(d.path(), 20, "lv-app.exe", &vivo), Adquirido::Tomado(_)));
    }
}
