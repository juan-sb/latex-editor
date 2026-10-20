//! La pantalla «Proyecto» del lado de la sesión (F8b): detectar sobre un proyecto SIN `latexviewer.json`, validar, escribir y probar con la
//! configuración propuesta. El motor es un `pdflatex` falso de PowerShell (el listado de figuras); sin TeX real.
#![cfg(windows)]

mod comun;

use lv_core::build::Builder;
use lv_core::cocinero::Cocinero;
use lv_core::doctor::Salida;
use lv_core::error::Error;
use lv_core::session::Session;
use std::ffi::OsString;
use std::fs;
use std::path::Path;
use tempfile::TempDir;

/// Un «pdflatex» que, con `-output-directory`, hace de listado: escribe la figlist con las figuras de las partes que nombra el
/// `\includeonly` del driver (2 por parte, con el slug de la parte).
const MOTOR_FALSO: &str = r##"$out = $null; $driver = $null
foreach ($a in $args) {
  if ($a -like '-output-directory=*') { $out = $a.Substring(18) }
  if ($a -like '*.tex') { $driver = $a }
}
$texto = Get-Content $driver -Raw
New-Item -ItemType Directory -Force "$out/figuras-cache" | Out-Null
$nombres = @()
foreach ($p in 'uno', 'dos') {
  if ($texto -notmatch 'includeonly' -or $texto -match "Secciones/$($p.Substring(0,1).ToUpper() + $p.Substring(1))") { $nombres += "figuras-cache/AAAAAA-$p-0", "figuras-cache/AAAAAA-$p-1" }
}
Set-Content "$out/lv-cocina.figlist" $nombres
foreach ($n in $nombres) { Set-Content "$out/$n.md5" "$n-v1" }
exit 0
"##;

fn script(contenido: &str) -> std::path::PathBuf {
    let fuera = TempDir::new().unwrap();
    let ruta = fuera.path().join("falso.ps1");
    fs::write(&ruta, contenido).unwrap();
    std::mem::forget(fuera);
    ruta
}

fn args_de(s: &Path) -> Vec<OsString> {
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"].iter().map(OsString::from).chain([s.as_os_str().to_owned()]).collect()
}

/// Un proyecto como el libro, en chico: raíz con su preámbulo, macro `\Capitulo` y flags de compilación reducida y de externalización.
fn proyecto() -> TempDir {
    let d = TempDir::new().unwrap();
    let e = |rel: &str, t: &str| {
        let p = d.path().join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, t).unwrap();
    };
    e("main.tex", "\\documentclass{book}\n\\input{structure}\n\\begin{document}\n\\ifdefined\\Reducida\\else\\tableofcontents\\fi\n\\Capitulo{Secciones/Uno}\n\\Capitulo{Secciones/Dos}\n\\end{document}\n");
    e(
        "structure.tex",
        "\\newcommand{\\Capitulo}[1]{\\include{#1}}\n\\ifdefined\\Externaliza\n  \\usetikzlibrary{external}\n  \\ifdefined\\Lista\n    \\tikzexternalize[prefix=figuras-cache/,mode=list and make]\n  \\else\n    \\tikzexternalize[prefix=figuras-cache/]\n  \\fi\n  \\edef\\Sello{\\pdf@filemdfivesum{estilo.tex}}\n\\fi\n",
    );
    e("estilo.tex", "estilo\n");
    e("Secciones/Uno.tex", "\\FigurasDe{uno}\nuno\n");
    e("Secciones/Dos.tex", "\\FigurasDe{dos}\ndos\n");
    d
}

fn abrir(d: &TempDir) -> std::sync::Arc<Session> {
    let r = comun::Recolector::nuevo();
    let latexmk = Builder::con_programa("powershell", args_de(&script("exit 0\n")));
    let motor = Cocinero::con_programa("powershell", args_de(&script(MOTOR_FALSO)));
    Session::open_with_cocinero(d.path(), r.sink.clone(), latexmk, motor).unwrap()
}

fn sonda_muda(_: &str, _: &[&str], _: Option<&Path>) -> Salida {
    Salida { lanzado: true, codigo: Some(0), texto: "pdfTeX 3.14 (MiKTeX 26.5)\nLVFMT:2026-06-01\nLVSE:1\n".into(), colgado: false }
}

#[test]
fn sin_latexviewer_json_se_detecta_todo_y_el_texto_propuesto_se_valida_y_se_escribe_tal_cual() {
    let d = proyecto();
    let s = abrir(&d);
    assert!(s.config_on_disk().unwrap().is_none());
    assert!(!s.view().unwrap().config_saved);
    let p = s.detect_project(None).unwrap();
    assert_eq!(p.raiz, "main.tex");
    assert_eq!(p.parts_commands, ["include", "Capitulo"]);
    assert_eq!(p.partes, ["Secciones/Uno", "Secciones/Dos"]);
    let usos: Vec<(String, String)> = p.flags.iter().map(|f| (f.nombre.clone(), serde_json::to_value(f.uso).unwrap().as_str().unwrap().to_string())).collect();
    for esperado in [("Reducida", "partial"), ("Externaliza", "externalize"), ("Lista", "figureList")] {
        assert!(usos.contains(&(esperado.0.to_string(), esperado.1.to_string())), "{esperado:?} en {usos:?}");
    }
    assert_eq!((p.figuras.modo.as_str(), p.figuras.dir.as_str(), p.figuras.stamp_files.as_slice()), ("project", "figuras-cache", ["estilo.tex".to_string()].as_slice()));
    // El texto propuesto valida, se normaliza igual y trae el ejemplo del nombre exportado.
    let v = s.validate_config(&p.texto);
    assert!(v.ok, "{:?}", v.errores);
    assert_eq!(v.normalizado.as_deref(), Some(p.texto.as_str()), "lo que se muestra es lo que se escribe");
    assert_eq!(v.ejemplo_nombre.as_deref(), Some("export/01 - Uno.pdf"));
    // Escribir: queda en el disco con el mismo texto, la sesión lo toma y la configuración pasa a estar guardada.
    let vista = s.write_config(&p.texto).unwrap();
    assert_eq!(fs::read_to_string(d.path().join("latexviewer.json")).unwrap(), p.texto);
    assert_eq!(s.config_on_disk().unwrap().as_deref(), Some(p.texto.as_str()));
    assert!(vista.config_saved && vista.config_error.is_none());
    assert_eq!(vista.root_file.as_deref(), Some("main.tex"));
    let ids: Vec<&str> = vista.config.as_ref().unwrap().profiles.iter().map(|x| x.id.as_str()).collect();
    assert_eq!(ids, ["parcial", "rapido", "completo", "entrega"]);
    assert_eq!(vista.parts.len(), 2);
    assert!(vista.state.active_profile.is_some_and(|a| ids.contains(&a.as_str())), "el perfil activo existe en la configuración nueva");
}

#[test]
fn una_configuracion_con_errores_no_se_escribe_y_dice_cual_es_el_problema() {
    let d = proyecto();
    let s = abrir(&d);
    let v = s.validate_config("{ \"root\": \"main.tex\", \"profiles\": {} }");
    assert!(!v.ok && v.errores[0].contains("perfil"), "{:?}", v.errores);
    let v = s.validate_config("{ esto no es json");
    assert!(!v.ok && v.errores[0].contains("latexviewer.json"), "{:?}", v.errores);
    let v = s.validate_config(r#"{ "root": "no-existe.tex", "profiles": { "completo": {} } }"#);
    assert!(!v.ok && v.errores.iter().any(|e| e.contains("no existe")), "{:?}", v.errores);
    assert!(matches!(s.write_config(r#"{ "root": "no-existe.tex", "profiles": { "completo": {} } }"#), Err(Error::NotFound(_))));
    assert!(matches!(s.write_config("{ esto no es json"), Err(_)));
    assert!(!d.path().join("latexviewer.json").exists(), "nada se escribió");
}

#[test]
fn cambiar_la_raiz_en_la_configuracion_cambia_la_de_la_sesion_y_no_toca_state_json() {
    let d = proyecto();
    fs::write(d.path().join("otro.tex"), "\\documentclass{article}\n\\begin{document}x\\end{document}\n").unwrap();
    let s = abrir(&d);
    let p = s.detect_project(None).unwrap();
    let con_otra = p.texto.replace("\"root\": \"main.tex\"", "\"root\": \"otro.tex\"");
    let vista = s.write_config(&con_otra).unwrap();
    assert_eq!(vista.root_file.as_deref(), Some("otro.tex"));
    assert!(fs::read_to_string(d.path().join("latexviewer.json")).unwrap().contains("\"root\": \"otro.tex\""));
    let estado = fs::read_to_string(d.path().join(".lv/state.json")).unwrap_or_default();
    assert!(!estado.contains("otro.tex"), "la raíz ya no se guarda en state.json: {estado}");
    // Con la sesión nueva (otra instancia, otro día) la raíz es la del proyecto.
    drop(s);
    assert_eq!(abrir(&d).view().unwrap().root_file.as_deref(), Some("otro.tex"));
}

#[test]
fn probar_lista_las_figuras_de_la_parte_con_la_configuracion_propuesta_sin_guardarla() {
    let d = proyecto();
    let s = abrir(&d);
    let p = s.detect_project(None).unwrap();
    let r = s.probe_config_con(&p.texto, Some("Secciones/Uno"), &sonda_muda).unwrap();
    assert_eq!((r.listado.parte.as_deref(), r.listado.figuras, r.listado.omitido.as_deref()), (Some("Secciones/Uno"), 2, None), "{:?}", r.listado);
    assert!(r.listado.nombres.iter().all(|n| n.contains("-uno-")), "{:?}", r.listado.nombres);
    assert!(r.doctor.hallazgos.iter().any(|h| h.id == "motor"), "el doctor corrió con la sonda");
    // Sin parte pedida, la primera; con una que no existe, un error; y no se guardó nada.
    assert_eq!(s.probe_config_con(&p.texto, None, &sonda_muda).unwrap().listado.parte.as_deref(), Some("Secciones/Uno"));
    assert!(s.probe_config_con(&p.texto, Some("Secciones/Tres"), &sonda_muda).is_err());
    assert!(!d.path().join("latexviewer.json").exists());
    // Una configuración sin cache de figuras no tiene nada que listar y lo dice.
    let sin_cache = r#"{ "root": "main.tex", "profiles": { "completo": {} } }"#;
    let r = s.probe_config_con(sin_cache, None, &sonda_muda).unwrap();
    assert!(r.listado.omitido.as_deref().is_some_and(|m| m.contains("no usa cache")), "{:?}", r.listado);
}
