//! La cocción de figuras en paralelo (sección 7 del plan). Dos pasos, los mismos que `Herramientas/cocinar_figuras.ps1` del
//! libro, pero lanzados por la app:
//!
//! 1. **Listado:** una pasada del motor sobre un driver `lv-cocina.tex` con el flag de listado de pgf (`mode=list and make`):
//!    no dibuja ninguna figura y escribe `lv-cocina.figlist` (un nombre por línea) y el `.md5` de cada una.
//! 2. **Cocción:** una subcompilación por figura pendiente, de a `jobs`, con la misma línea de comandos que usa pgf
//!    (`-jobname "<cache>/<figura>" "\def\tikzexternalrealjob{<job>}\input{<job>}"`), cwd en la raíz y sin `-output-directory`.
//!    Como no pasan por latexmk, la app les pone `TEXINPUTS` con `.lv/drivers` (lo que en un build hace `.lv/latexmkrc`).
//!
//! Cada figura que termina pasa por `figures::verificar`; sólo si sale bien su `.md5` nuevo (el del listado) pasa al cache
//! compartido. Cancelar mata el árbol entero (Job Object) y borra lo que quedó cortado. La cocción cede el paso: si `cede()`
//! dice que hay un build esperando, deja de lanzar, espera las que están en vuelo y devuelve lo que falta.

use crate::auxiliares::build_dir;
use crate::error::{Error, Result};
use crate::figures::{self, FiguraRota};
use crate::procs::Job;
use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
/// Sin esto cada subcompilación abre una ventana de consola.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// El perfil oculto con el que se lista, y el nombre del driver (es el `\jobname` del listado y el `\tikzexternalrealjob`).
pub const PERFIL_COCINA: &str = "cocina";
pub const JOB_COCINA: &str = "lv-cocina";

/// Una figura que no termina en este tiempo se mata: un `tikzpicture` en un bucle infinito no puede dejar la cola trabada.
const TIEMPO_POR_FIGURA: Duration = Duration::from_secs(600);

#[derive(Debug, Clone)]
pub struct Opciones {
    pub root: PathBuf,
    /// `pdflatex`, `xelatex` o `lualatex`.
    pub engine: String,
    /// La carpeta del cache (`figuras-cache`).
    pub dir: String,
    /// Subcompilaciones a la vez.
    pub jobs: usize,
}

/// Qué pasó con lo que se pidió cocinar.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResultadoCoccion {
    /// Las que salieron bien y quedaron en el cache con su `.md5`.
    pub cocidas: Vec<String>,
    pub rotas: Vec<FiguraRota>,
    /// Las que no se llegaron a lanzar (porque cedió el paso o se canceló).
    pub restantes: Vec<String>,
    pub cancelado: bool,
    pub cedio: bool,
    pub ms: u64,
}

/// El avance de la cocción: cuántas terminaron de las que se pidieron y cuál fue la última.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Avance {
    pub hechas: usize,
    pub total: usize,
    pub nombre: String,
    pub ok: bool,
}

/// El ejecutable del motor y los argumentos que van antes de los suyos: los tests lo cambian por un script.
#[derive(Debug, Clone)]
pub struct Cocinero {
    programa: Option<OsString>,
    pre_args: Vec<OsString>,
}

impl Default for Cocinero {
    fn default() -> Self {
        Self::new()
    }
}

fn sep_de_rutas() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}

impl Cocinero {
    pub fn new() -> Self {
        Cocinero { programa: None, pre_args: vec![] }
    }

    /// Los tests le pasan un script en lugar del motor.
    pub fn con_programa(programa: impl Into<OsString>, pre_args: Vec<OsString>) -> Self {
        Cocinero { programa: Some(programa.into()), pre_args }
    }

    fn comando(&self, o: &Opciones) -> Command {
        let mut c = match &self.programa {
            Some(p) => {
                let mut c = Command::new(p);
                c.args(&self.pre_args);
                c
            }
            None => Command::new(&o.engine),
        };
        c.current_dir(&o.root)
            .env("max_print_line", "10000")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        c.creation_flags(CREATE_NO_WINDOW);
        c
    }

    fn error_de_lanzamiento(&self, o: &Opciones, e: std::io::Error) -> Error {
        let programa = self.programa.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| o.engine.clone());
        match e.kind() {
            std::io::ErrorKind::NotFound => Error::NoLatexmk(format!("{programa}: no está en el PATH (¿está instalado MiKTeX o TeX Live?)")),
            _ => Error::NoLatexmk(format!("{programa}: {e}")),
        }
    }

    /// El listado: una pasada del motor sobre `.lv/drivers/lv-cocina.tex` (que quien llama ya escribió). Devuelve los nombres de
    /// la figlist. Los `.md5` que pgf escribe quedan en `.lv/build/cocina/<cache>/`: `figcache::pendientes` los compara con los del
    /// cache compartido y recién una figura verificada los instala.
    pub fn listar(&self, o: &Opciones, job: &Arc<Job>, cancelado: &AtomicBool) -> Result<Vec<String>> {
        let salida = build_dir(&o.root, PERFIL_COCINA);
        // Lo que dejó un listado anterior no puede colarse en éste (un `.md5` viejo haría ver una figura como al día).
        let _ = fs::remove_file(salida.join(format!("{JOB_COCINA}.figlist")));
        for e in fs::read_dir(salida.join(&o.dir)).into_iter().flatten().flatten() {
            if e.path().extension().is_some_and(|x| x == "md5") {
                let _ = fs::remove_file(e.path());
            }
        }
        let mut cmd = self.comando(o);
        cmd.args(["-shell-escape", "-interaction=nonstopmode", "-file-line-error"])
            .arg(format!("-output-directory=.lv/build/{PERFIL_COCINA}"))
            .arg(format!(".lv/drivers/{JOB_COCINA}.tex"));
        let mut hijo = cmd.spawn().map_err(|e| self.error_de_lanzamiento(o, e))?;
        job.assign(&hijo);
        loop {
            if cancelado.load(Ordering::SeqCst) {
                job.terminate();
                let _ = hijo.kill();
                let _ = hijo.wait();
                return Err(Error::Other("cancelado".into()));
            }
            match hijo.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(e) => return Err(Error::Io(e.to_string())),
            }
        }
        let figlist = salida.join(format!("{JOB_COCINA}.figlist"));
        let texto = fs::read_to_string(&figlist).map_err(|_| {
            Error::Other(format!(
                "el listado de figuras no generó {JOB_COCINA}.figlist: el documento no compila hasta ahí (revisá .lv/build/{PERFIL_COCINA}/{JOB_COCINA}.log)"
            ))
        })?;
        Ok(crate::figcache::parsear_figlist(&texto))
    }

    fn lanzar_figura(&self, o: &Opciones, nombre: &str, job: &Job) -> Result<Child> {
        let mut cmd = self.comando(o);
        cmd.args(["-shell-escape", "-halt-on-error", "-interaction=batchmode"])
            .arg(format!("-jobname={nombre}"))
            .arg(format!("\\def\\tikzexternalrealjob{{{JOB_COCINA}}}\\input{{{JOB_COCINA}}}"))
            .env("TEXINPUTS", format!(".lv/drivers{}{}", sep_de_rutas(), std::env::var("TEXINPUTS").unwrap_or_default()));
        let hijo = cmd.spawn().map_err(|e| self.error_de_lanzamiento(o, e))?;
        job.assign(&hijo);
        Ok(hijo)
    }

    /// Cocina `nombres` en orden, de a `o.jobs`. `cede` se mira antes de lanzar cada figura: si es verdadero deja de lanzar, espera
    /// las que están en vuelo y devuelve el resto en `restantes`. `avance` se llama cada vez que una figura termina.
    pub fn cocer(
        &self,
        o: &Opciones,
        nombres: &[String],
        job: &Arc<Job>,
        cancelado: &AtomicBool,
        cede: &dyn Fn() -> bool,
        avance: &dyn Fn(Avance),
    ) -> Result<ResultadoCoccion> {
        let inicio = Instant::now();
        let total = nombres.len();
        let jobs = o.jobs.max(1);
        let mut res = ResultadoCoccion::default();
        let mut cola: VecDeque<String> = nombres.iter().cloned().collect();
        let mut en_vuelo: Vec<(Child, String, SystemTime, Instant)> = Vec::new();
        let mut hechas = 0usize;
        let nuevo_md5 = |n: &str| build_dir(&o.root, PERFIL_COCINA).join(format!("{n}.md5"));

        let terminar = |nombre: &str, desde: SystemTime, res: &mut ResultadoCoccion, forzada: bool| -> bool {
            let rotas = figures::verificar(&o.root, PERFIL_COCINA, &[nombre.to_string()], desde, forzada || res.cancelado);
            if rotas.is_empty() {
                // Verificada: su `.md5` nuevo (el del listado) pasa al cache compartido.
                let destino = o.root.join(format!("{nombre}.md5"));
                let origen = nuevo_md5(nombre);
                if origen.is_file() && (fs::rename(&origen, &destino).is_ok() || (fs::copy(&origen, &destino).is_ok() && fs::remove_file(&origen).is_ok())) {
                    // ok
                }
                res.cocidas.push(nombre.to_string());
                true
            } else {
                res.rotas.extend(rotas);
                false
            }
        };

        loop {
            // 1. Las que terminaron.
            let mut i = 0;
            while i < en_vuelo.len() {
                let vencida = en_vuelo[i].3.elapsed() > TIEMPO_POR_FIGURA;
                let estado = if vencida { None } else { en_vuelo[i].0.try_wait().ok().flatten() };
                if estado.is_some() || vencida {
                    let (mut hijo, nombre, desde, _) = en_vuelo.swap_remove(i);
                    if vencida {
                        let _ = hijo.kill();
                        let _ = hijo.wait();
                    }
                    let ok = terminar(&nombre, desde, &mut res, false);
                    hechas += 1;
                    avance(Avance { hechas, total, nombre, ok });
                } else {
                    i += 1;
                }
            }
            // 2. Cancelar: se mata el árbol y lo que estaba en vuelo se borra sin informar como error.
            if cancelado.load(Ordering::SeqCst) {
                res.cancelado = true;
                job.terminate();
                for (mut hijo, nombre, desde, _) in en_vuelo.drain(..) {
                    let _ = hijo.kill();
                    let _ = hijo.wait();
                    terminar(&nombre, desde, &mut res, true);
                }
                res.restantes = cola.drain(..).collect();
                break;
            }
            // 3. Lanzar más, salvo que haya que ceder el paso a un build.
            let ceder = cede();
            while en_vuelo.len() < jobs && !ceder {
                let Some(n) = cola.pop_front() else { break };
                let desde = SystemTime::now();
                match self.lanzar_figura(o, &n, job) {
                    Ok(h) => en_vuelo.push((h, n, desde, Instant::now())),
                    Err(e) => {
                        // Sin motor no hay nada que cocinar: se corta todo, no se marca cada figura como rota.
                        job.terminate();
                        for (mut hijo, _, _, _) in en_vuelo.drain(..) {
                            let _ = hijo.kill();
                            let _ = hijo.wait();
                        }
                        return Err(e);
                    }
                }
            }
            if en_vuelo.is_empty() && (cola.is_empty() || ceder) {
                if ceder && !cola.is_empty() {
                    res.cedio = true;
                    res.restantes = cola.drain(..).collect();
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        res.ms = inicio.elapsed().as_millis() as u64;
        Ok(res)
    }
}

/// Ruta del driver de la cocción, relativa a la raíz.
pub fn driver_cocina_rel() -> String {
    format!(".lv/drivers/{JOB_COCINA}.tex")
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tempfile::TempDir;

    /// Un "pdflatex" falso en PowerShell. Con `-output-directory` hace de listado (escribe la figlist y un `.md5` por figura);
    /// con `-jobname=` hace de subcompilación: deja `<jobname>.pdf` y `.log`, y anota cuándo empezó y terminó en `marcas/`.
    const FALSO: &str = r##"$modo = 'sub'; $job = $null; $out = $null
foreach ($a in $args) {
  if ($a -like '-jobname=*') { $job = $a.Substring(9) }
  if ($a -like '-output-directory=*') { $out = $a.Substring(18); $modo = 'listado' }
}
if ($modo -eq 'listado') {
  New-Item -ItemType Directory -Force "$out/figuras-cache" | Out-Null
  $nombres = @('figuras-cache/S-a-0', 'figuras-cache/S-a-1', 'figuras-cache/S-b-0', 'figuras-cache/S-b-1')
  Set-Content "$out/lv-cocina.figlist" $nombres
  foreach ($n in $nombres) { Set-Content "$out/$n.md5" "md5-de-$n" }
  exit 0
}
New-Item -ItemType Directory -Force 'marcas' | Out-Null
$corto = $job.Split('/')[-1]
$ini = [DateTime]::UtcNow.Ticks
"TEXINPUTS=$env:TEXINPUTS" | Set-Content "marcas/$corto.env"
Start-Sleep -Milliseconds 700
if ($job -like '*roto*') {
  Set-Content "$job.log" "(./main.tex`n! Undefined control sequence.`nl.7 \foo`n`n! ==> Fatal error occurred, no output PDF file produced!"
  exit 1
}
Set-Content "$job.pdf" "%PDF-1.5`n%%EOF"
Set-Content "$job.log" 'This is pdfTeX'
"$ini $([DateTime]::UtcNow.Ticks)" | Set-Content "marcas/$corto.txt"
"##;

    fn proyecto() -> (TempDir, Opciones, Cocinero) {
        let d = TempDir::new().unwrap();
        let fuera = TempDir::new().unwrap();
        let script = fuera.path().join("falso.ps1");
        fs::write(&script, FALSO).unwrap();
        std::mem::forget(fuera);
        fs::create_dir_all(d.path().join("figuras-cache")).unwrap();
        let c = Cocinero::con_programa(
            "powershell",
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"].iter().map(OsString::from).chain([script.into_os_string()]).collect(),
        );
        let o = Opciones { root: d.path().to_path_buf(), engine: "pdflatex".into(), dir: "figuras-cache".into(), jobs: 2 };
        (d, o, c)
    }

    fn nombres(v: &[&str]) -> Vec<String> {
        v.iter().map(|n| format!("figuras-cache/{n}")).collect()
    }

    fn sin_cancelar() -> AtomicBool {
        AtomicBool::new(false)
    }

    fn job() -> Arc<Job> {
        Arc::new(Job::new().expect("Job Object"))
    }

    #[test]
    fn el_listado_devuelve_la_figlist_y_deja_los_md5_en_el_directorio_de_cocina() {
        let (d, o, c) = proyecto();
        fs::create_dir_all(build_dir(d.path(), PERFIL_COCINA).join("figuras-cache")).unwrap();
        // Un md5 y una figlist de un listado anterior no pueden colarse.
        fs::write(build_dir(d.path(), PERFIL_COCINA).join("figuras-cache/viejo.md5"), "x").unwrap();
        let lista = c.listar(&o, &job(), &sin_cancelar()).unwrap();
        assert_eq!(lista, nombres(&["S-a-0", "S-a-1", "S-b-0", "S-b-1"]));
        let cocina = build_dir(d.path(), PERFIL_COCINA);
        assert!(cocina.join("figuras-cache/S-a-0.md5").is_file());
        assert!(!cocina.join("figuras-cache/viejo.md5").exists());
        assert!(!d.path().join("figuras-cache/S-a-0.md5").exists(), "el listado no toca el cache compartido: eso es lo que daría la figura por buena");
    }

    #[test]
    fn un_listado_que_no_escribe_la_figlist_es_un_error_que_dice_donde_mirar() {
        let (d, o, _) = proyecto();
        let c = Cocinero::con_programa("powershell", ["-NoProfile", "-Command", "exit 0"].iter().map(OsString::from).collect());
        let e = c.listar(&o, &job(), &sin_cancelar()).unwrap_err().to_string();
        assert!(e.contains("lv-cocina.figlist") && e.contains(".lv/build/cocina"), "{e}");
        let _ = d;
    }

    #[test]
    fn coce_todas_respeta_el_paralelismo_instala_los_md5_y_pone_texinputs() {
        let (d, mut o, c) = proyecto();
        o.jobs = 2;
        let lista = nombres(&["S-a-0", "S-a-1", "S-b-0", "S-b-1"]);
        c.listar(&o, &job(), &sin_cancelar()).unwrap();
        let avances = std::sync::Mutex::new(Vec::new());
        let r = c.cocer(&o, &lista, &job(), &sin_cancelar(), &|| false, &|a| avances.lock().unwrap().push(a)).unwrap();
        assert_eq!(r.cocidas.len(), 4, "{r:?}");
        assert!(r.rotas.is_empty() && r.restantes.is_empty() && !r.cancelado && !r.cedio);
        for n in &lista {
            assert!(d.path().join(format!("{n}.pdf")).is_file());
            assert_eq!(fs::read_to_string(d.path().join(format!("{n}.md5"))).unwrap().trim(), format!("md5-de-{n}"), "el md5 del listado se instala al verificar");
            assert!(!build_dir(d.path(), PERFIL_COCINA).join(format!("{n}.md5")).exists());
        }
        let av = avances.lock().unwrap();
        assert_eq!(av.iter().map(|a| a.hechas).collect::<Vec<_>>(), [1, 2, 3, 4]);
        assert!(av.iter().all(|a| a.total == 4 && a.ok));
        // Paralelismo: nunca más de 2 a la vez y, con 4 figuras de 700 ms, sí hubo 2 a la vez.
        let intervalos: Vec<(i64, i64)> = lista
            .iter()
            .map(|n| {
                let t = fs::read_to_string(d.path().join(format!("marcas/{}.txt", n.rsplit('/').next().unwrap()))).unwrap();
                let mut p = t.split_whitespace().map(|x| x.parse::<i64>().unwrap());
                (p.next().unwrap(), p.next().unwrap())
            })
            .collect();
        let max_a_la_vez = intervalos.iter().map(|(ini, _)| intervalos.iter().filter(|(a, b)| a <= ini && ini < b).count()).max().unwrap();
        assert_eq!(max_a_la_vez, 2, "{intervalos:?}");
        let env = fs::read_to_string(d.path().join("marcas/S-a-0.env")).unwrap();
        assert!(env.contains("TEXINPUTS=.lv/drivers;"), "las subcompilaciones no pasan por latexmk: la app pone TEXINPUTS ({env})");
    }

    #[test]
    fn una_figura_rota_no_corta_las_demas_y_su_md5_no_llega_al_cache() {
        let (d, o, c) = proyecto();
        std::fs::write(d.path().join("main.tex"), "\\documentclass{article}\n").unwrap();
        let lista = nombres(&["S-a-0", "S-roto-0", "S-b-0"]);
        for n in &lista {
            fs::create_dir_all(build_dir(d.path(), PERFIL_COCINA).join("figuras-cache")).unwrap();
            fs::write(build_dir(d.path(), PERFIL_COCINA).join(format!("{n}.md5")), "nuevo").unwrap();
        }
        // La rota tenía un PDF y un md5 viejos y buenos: no pueden quedar.
        fs::write(d.path().join("figuras-cache/S-roto-0.pdf"), "%PDF-1.5\n%%EOF").unwrap();
        fs::write(d.path().join("figuras-cache/S-roto-0.md5"), "viejo").unwrap();
        let r = c.cocer(&o, &lista, &job(), &sin_cancelar(), &|| false, &|_| {}).unwrap();
        assert_eq!(r.cocidas.len(), 2);
        assert!(r.cocidas.contains(&"figuras-cache/S-a-0".to_string()) && r.cocidas.contains(&"figuras-cache/S-b-0".to_string()), "{r:?}");
        assert_eq!(r.rotas.len(), 1);
        assert_eq!(r.rotas[0].nombre, "figuras-cache/S-roto-0");
        assert!(r.rotas[0].problemas[0].message.contains("Undefined control sequence"));
        assert!(!d.path().join("figuras-cache/S-roto-0.pdf").exists() && !d.path().join("figuras-cache/S-roto-0.md5").exists());
        assert!(d.path().join("figuras-cache/S-a-0.md5").is_file());
    }

    #[test]
    fn cede_el_paso_cuando_hay_un_build_esperando_y_devuelve_lo_que_falta() {
        let (d, mut o, c) = proyecto();
        o.jobs = 1;
        let lista = nombres(&["S-a-0", "S-a-1", "S-b-0", "S-b-1"]);
        c.listar(&o, &job(), &sin_cancelar()).unwrap();
        let lanzadas = AtomicUsize::new(0);
        // Llega un pedido de build apenas se lanzó la primera.
        let cede = || {
            lanzadas.fetch_add(1, Ordering::SeqCst);
            lanzadas.load(Ordering::SeqCst) > 3
        };
        let r = c.cocer(&o, &lista, &job(), &sin_cancelar(), &cede, &|_| {}).unwrap();
        assert!(r.cedio && !r.cancelado);
        assert!(!r.cocidas.is_empty() && r.cocidas.len() < 4, "{r:?}");
        assert_eq!(r.cocidas.len() + r.restantes.len(), 4, "lo que no se lanzó vuelve para retomar después: {r:?}");
        for n in &r.cocidas {
            assert!(d.path().join(format!("{n}.pdf")).is_file(), "las que estaban en vuelo se esperaron hasta el final");
        }
    }

    #[test]
    fn cancelar_mata_las_que_estan_en_vuelo_y_borra_lo_cortado_sin_informar_error() {
        let (d, mut o, c) = proyecto();
        o.jobs = 2;
        let lista = nombres(&["S-a-0", "S-a-1", "S-b-0", "S-b-1"]);
        c.listar(&o, &job(), &sin_cancelar()).unwrap();
        // El md5 del listado de las dos primeras está, y un PDF cortado de una figura lanzada.
        fs::write(d.path().join("figuras-cache/S-a-0.pdf"), "%PDF-1.5 cortado").unwrap();
        let cancelado = Arc::new(AtomicBool::new(false));
        let flag = cancelado.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            flag.store(true, Ordering::SeqCst);
        });
        let inicio = Instant::now();
        let r = c.cocer(&o, &lista, &job(), &cancelado, &|| false, &|_| {}).unwrap();
        t.join().unwrap();
        assert!(r.cancelado);
        assert!(inicio.elapsed() < Duration::from_millis(1500), "cancelar no espera a que terminen: {:?}", inicio.elapsed());
        assert!(r.cocidas.is_empty(), "{r:?}");
        assert!(r.rotas.iter().all(|f| f.problemas.is_empty()), "cancelar no es un error del proyecto");
        assert_eq!(r.rotas.len() + r.restantes.len(), 4);
        assert!(!d.path().join("figuras-cache/S-a-0.pdf").exists(), "el PDF cortado se borra");
        for n in &lista {
            assert!(!d.path().join(format!("{n}.md5")).exists(), "ningún md5 da por buena una figura cancelada");
        }
    }

    #[test]
    fn sin_motor_instalado_es_un_error_unico_y_no_cuatro_figuras_rotas() {
        let (_d, o, _) = proyecto();
        let c = Cocinero::con_programa("programa-que-no-existe-lv", vec![]);
        let e = c.cocer(&o, &nombres(&["S-a-0", "S-a-1"]), &job(), &sin_cancelar(), &|| false, &|_| {}).unwrap_err().to_string();
        assert!(e.contains("programa-que-no-existe-lv"), "{e}");
    }
}
