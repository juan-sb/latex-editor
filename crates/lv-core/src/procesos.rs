//! Procesos de TeX del proyecto que quedaron de antes (5.6 del plan, F8): un `pdflatex` o un `latexmk` huérfano retiene el PDF y los
//! auxiliares y el build siguiente falla o se cuelga. Los Job Objects (`procs.rs`) matan el árbol aunque la app muera, pero un hijo que
//! latexmk lance en los primeros milisegundos antes de entrar al Job puede escaparse.
//!
//! **Cómo se sabe de qué proyecto es un proceso**: por su directorio de trabajo. Todo lo que lanza la app (latexmk, pdflatex, biber,
//! makeindex, perl) corre con la raíz del proyecto como directorio actual, y sus argumentos son relativos (`.lv/build/...`): la
//! línea de comandos no dice de qué proyecto es. El directorio de trabajo de otro proceso se lee de su bloque de entorno de proceso (PEB).
//! Sólo se ofrecen procesos **del mismo usuario** cuyo directorio actual esté adentro de la raíz.

use serde::Serialize;
use std::path::Path;

/// Los ejecutables que lanza una compilación.
pub const NOMBRES_DE_TEX: [&str; 11] = [
    "pdflatex.exe",
    "xelatex.exe",
    "lualatex.exe",
    "latexmk.exe",
    "perl.exe",
    "biber.exe",
    "makeindex.exe",
    "pdftex.exe",
    "miktex-pdftex.exe",
    "miktex-xetex.exe",
    "miktex-luatex.exe",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProcesoTex {
    pub pid: u32,
    pub nombre: String,
    /// Su directorio de trabajo (una ruta de la raíz del proyecto o de una carpeta de adentro).
    pub cwd: String,
    /// Su línea de comandos, para que la persona vea qué es antes de matarlo.
    pub linea: String,
}

/// Un proceso vivo: pid, padre, nombre del ejecutable, directorio de trabajo y línea de comandos (vacíos si no se pudieron leer).
#[derive(Debug, Clone)]
pub struct Visto {
    pub pid: u32,
    pub nombre: String,
    pub cwd: String,
    pub linea: String,
}

fn normalizar(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase().trim_start_matches("//?/").to_string()
}

/// ¿`cwd` es `raiz` o está adentro?
pub fn esta_adentro(cwd: &str, raiz: &Path) -> bool {
    let c = normalizar(cwd);
    let r = normalizar(&dunce::simplified(raiz).to_string_lossy());
    !c.is_empty() && !r.is_empty() && (c == r || c.starts_with(&format!("{r}/")))
}

/// De entre los procesos vistos, los de estos nombres con el directorio de trabajo adentro de `raiz` (sin contar a este proceso).
pub fn filtrar(vistos: Vec<Visto>, raiz: &Path, nombres: &[&str]) -> Vec<ProcesoTex> {
    let yo = std::process::id();
    let mut v: Vec<ProcesoTex> = vistos
        .into_iter()
        .filter(|p| p.pid != yo && nombres.iter().any(|n| n.eq_ignore_ascii_case(&p.nombre)) && esta_adentro(&p.cwd, raiz))
        .map(|p| ProcesoTex { pid: p.pid, nombre: p.nombre, cwd: p.cwd, linea: p.linea })
        .collect();
    v.sort_by_key(|p| p.pid);
    v
}

/// Los procesos de TeX (`NOMBRES_DE_TEX`) del proyecto que están corriendo ahora.
pub fn de_tex_en(raiz: &Path) -> Vec<ProcesoTex> {
    de_nombres_en(raiz, &NOMBRES_DE_TEX)
}

pub fn de_nombres_en(raiz: &Path, nombres: &[&str]) -> Vec<ProcesoTex> {
    filtrar(imp::listar(nombres), raiz, nombres)
}

/// Cuántos procesos de TeX hay corriendo en la máquina (de cualquier proyecto), sin contar a este proceso. Para el historial: «había
/// otro pdflatex corriendo» explica un build lento.
pub fn cuantos_de_tex() -> usize {
    let yo = std::process::id();
    imp::listar(&NOMBRES_DE_TEX).iter().filter(|p| p.pid != yo && p.nombre.to_lowercase() != "perl.exe").count()
}

/// Mata el proceso y todo lo que lanzó (`taskkill /T /F`). Devuelve si el comando salió bien.
pub fn matar_arbol(pid: u32) -> bool {
    imp::matar_arbol(pid)
}

#[cfg(windows)]
mod imp {
    use super::Visto;
    use std::ffi::c_void;
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};

    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(h: HANDLE, clase: u32, info: *mut c_void, largo: u32, devuelto: *mut u32) -> i32;
    }

    #[repr(C)]
    struct BasicInformation {
        exit_status: i32,
        peb: usize,
        afinidad: usize,
        prioridad: i32,
        pid: usize,
        padre: usize,
    }

    fn leer<T: Copy + Default>(h: HANDLE, dir: usize) -> Option<T> {
        let mut v = T::default();
        let mut leidos = 0usize;
        let ok = unsafe { ReadProcessMemory(h, dir as *const c_void, &mut v as *mut T as *mut c_void, std::mem::size_of::<T>(), &mut leidos) };
        (ok != 0 && leidos == std::mem::size_of::<T>()).then_some(v)
    }

    /// Un UNICODE_STRING de otro proceso (x64: largo u16, máximo u16, relleno, puntero a los caracteres).
    fn texto(h: HANDLE, dir: usize) -> String {
        let (Some(largo), Some(buf)) = (leer::<u16>(h, dir), leer::<usize>(h, dir + 8)) else { return String::new() };
        if largo == 0 || buf == 0 || largo > 32_000 {
            return String::new();
        }
        let mut u = vec![0u16; largo as usize / 2];
        let mut leidos = 0usize;
        let ok = unsafe { ReadProcessMemory(h, buf as *const c_void, u.as_mut_ptr() as *mut c_void, largo as usize, &mut leidos) };
        if ok == 0 {
            return String::new();
        }
        String::from_utf16_lossy(&u)
    }

    /// Directorio de trabajo y línea de comandos de un proceso (PEB → RTL_USER_PROCESS_PARAMETERS: el directorio actual en +0x38 y la
    /// línea de comandos en +0x70). Sólo vale para procesos de 64 bits del mismo usuario, que es lo que son pdflatex, latexmk y perl.
    fn cwd_y_linea(pid: u32) -> (String, String) {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
            if h.is_null() {
                return (String::new(), String::new());
            }
            let mut info = BasicInformation { exit_status: 0, peb: 0, afinidad: 0, prioridad: 0, pid: 0, padre: 0 };
            let mut devuelto = 0u32;
            let r = NtQueryInformationProcess(h, 0, &mut info as *mut _ as *mut c_void, std::mem::size_of::<BasicInformation>() as u32, &mut devuelto);
            let salida = if r == 0 && info.peb != 0 {
                match leer::<usize>(h, info.peb + 0x20) {
                    Some(params) if params != 0 => (texto(h, params + 0x38), texto(h, params + 0x70)),
                    _ => (String::new(), String::new()),
                }
            } else {
                (String::new(), String::new())
            };
            CloseHandle(h);
            salida
        }
    }

    pub fn listar(nombres: &[&str]) -> Vec<Visto> {
        let mut out = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return out;
            }
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut hay = Process32FirstW(snap, &mut e) != 0;
            while hay {
                let largo = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                let nombre = String::from_utf16_lossy(&e.szExeFile[..largo]);
                if nombres.iter().any(|n| n.eq_ignore_ascii_case(&nombre)) {
                    let (cwd, linea) = cwd_y_linea(e.th32ProcessID);
                    out.push(Visto { pid: e.th32ProcessID, nombre, cwd, linea });
                }
                hay = Process32NextW(snap, &mut e) != 0;
            }
            CloseHandle(snap);
        }
        out
    }

    pub fn matar_arbol(pid: u32) -> bool {
        std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Visto;
    pub fn listar(_: &[&str]) -> Vec<Visto> {
        Vec::new()
    }
    pub fn matar_arbol(_: u32) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn visto(pid: u32, nombre: &str, cwd: &str) -> Visto {
        Visto { pid, nombre: nombre.into(), cwd: cwd.into(), linea: String::new() }
    }

    #[test]
    fn un_proceso_es_del_proyecto_si_su_directorio_de_trabajo_esta_adentro_de_la_raiz() {
        let raiz = Path::new(r"C:\Users\x\Libro TC");
        assert!(esta_adentro(r"C:\Users\x\Libro TC", raiz));
        assert!(esta_adentro(r"c:\users\x\libro tc\", raiz), "mayúsculas y barra final no cuentan");
        assert!(esta_adentro(r"C:\Users\x\Libro TC\.lv\build\parcial", raiz));
        assert!(esta_adentro(r"\\?\C:\Users\x\Libro TC", raiz), "el prefijo \\?\\ no cuenta");
        assert!(!esta_adentro(r"C:\Users\x\Libro TC 2", raiz), "otra carpeta con el mismo comienzo");
        assert!(!esta_adentro(r"C:\Users\x", raiz));
        assert!(!esta_adentro("", raiz), "no se pudo leer: no es de nadie");
    }

    #[test]
    fn se_filtran_por_nombre_y_por_directorio_y_nunca_este_proceso() {
        let raiz = Path::new(r"C:\p");
        let yo = std::process::id();
        let vistos = vec![
            visto(10, "pdflatex.exe", r"C:\p"),
            visto(11, "PDFLATEX.EXE", r"C:\p\Secciones"),
            visto(12, "pdflatex.exe", r"C:\otro"),
            visto(13, "notepad.exe", r"C:\p"),
            visto(yo, "pdflatex.exe", r"C:\p"),
            visto(14, "latexmk.exe", ""),
        ];
        let v = filtrar(vistos, raiz, &NOMBRES_DE_TEX);
        assert_eq!(v.iter().map(|p| p.pid).collect::<Vec<_>>(), [10, 11]);
    }

    #[cfg(windows)]
    #[test]
    fn un_proceso_de_verdad_con_la_raiz_como_directorio_se_encuentra_y_se_mata_con_sus_hijos() {
        let d = tempfile::tempdir().unwrap();
        let raiz = dunce::canonicalize(d.path()).unwrap();
        let fuera = tempfile::tempdir().unwrap();
        let dormir = |dir: &Path| {
            std::process::Command::new("powershell")
                .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 120"])
                .current_dir(dir)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap()
        };
        let mut adentro = dormir(&raiz);
        let mut afuera = dormir(fuera.path());
        // El proceso tarda un instante en tener su bloque de entorno armado.
        let mut v = Vec::new();
        for _ in 0..50 {
            v = de_nombres_en(&raiz, &["powershell.exe"]);
            if !v.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert_eq!(v.len(), 1, "sólo el que trabaja adentro de la raíz: {v:?}");
        assert_eq!(v[0].pid, adentro.id());
        assert!(v[0].linea.contains("Start-Sleep"), "se ve qué es: {:?}", v[0].linea);
        assert!(matar_arbol(v[0].pid));
        adentro.wait().unwrap();
        assert!(de_nombres_en(&raiz, &["powershell.exe"]).is_empty());
        afuera.kill().unwrap();
        afuera.wait().unwrap();
    }
}
