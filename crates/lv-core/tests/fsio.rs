//! Tests de `fsio`: EOL, BOM, versión, rutas y escritura atómica. Es el control bloqueante de F1: guardar no puede
//! cambiar los bytes de lo que el usuario no tocó.

use lv_core::error::Error;
use lv_core::fsio::{self, Eol, Format};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

fn proyecto(contenido: &[u8]) -> (TempDir, PathBuf) {
    let d = TempDir::new().unwrap();
    let p = d.path().join("a.tex");
    fs::write(&p, contenido).unwrap();
    (d, p)
}

fn con_bom(b: &[u8]) -> Vec<u8> {
    [&BOM[..], b].concat()
}

fn reemplazar(b: &[u8], de: &[u8], por: &[u8]) -> Vec<u8> {
    let i = b.windows(de.len()).position(|w| w == de).expect("el caso tiene que contener la palabra");
    [&b[..i], por, &b[i + de.len()..]].concat()
}

/// Casos de formato uniforme: (nombre, bytes, eol, bom, texto normalizado).
fn casos() -> Vec<(&'static str, Vec<u8>, Eol, bool, &'static str)> {
    vec![
        ("lf", b"uno\ndos\ntres\n".to_vec(), Eol::Lf, false, "uno\ndos\ntres\n"),
        ("crlf", b"uno\r\ndos\r\ntres\r\n".to_vec(), Eol::Crlf, false, "uno\ndos\ntres\n"),
        ("solo cr", b"uno\rdos\rtres\r".to_vec(), Eol::Cr, false, "uno\ndos\ntres\n"),
        ("bom y lf", con_bom(b"uno\ndos\ntres\n"), Eol::Lf, true, "uno\ndos\ntres\n"),
        ("bom y crlf", con_bom(b"uno\r\ndos\r\ntres\r\n"), Eol::Crlf, true, "uno\ndos\ntres\n"),
        ("lf sin salto final", b"uno\ndos\ntres".to_vec(), Eol::Lf, false, "uno\ndos\ntres"),
        ("crlf sin salto final", b"uno\r\ndos\r\ntres".to_vec(), Eol::Crlf, false, "uno\ndos\ntres"),
        ("utf8 con acentos", "áéíóú ñ\ndos ü\n".as_bytes().to_vec(), Eol::Lf, false, "áéíóú ñ\ndos ü\n"),
    ]
}

#[test]
fn lee_el_formato_de_cada_caso() {
    for (nombre, bytes, eol, bom, texto) in casos() {
        let (d, _) = proyecto(&bytes);
        let r = fsio::read_file(d.path(), "a.tex").unwrap();
        assert_eq!(r.eol, eol, "{nombre}: eol");
        assert_eq!(r.bom, bom, "{nombre}: bom");
        assert!(!r.mixed, "{nombre}: no es mezclado");
        assert_eq!(r.text, texto, "{nombre}: texto normalizado");
        assert_eq!(r.version, fsio::version_of(&bytes), "{nombre}: versión");
    }
}

#[test]
fn ida_y_vuelta_sin_cambios_no_escribe_ni_toca_el_mtime() {
    for (nombre, bytes, ..) in casos() {
        let (d, p) = proyecto(&bytes);
        let mtime = fs::metadata(&p).unwrap().modified().unwrap();
        let r = fsio::read_file(d.path(), "a.tex").unwrap();
        let o = fsio::write_file(d.path(), "a.tex", &r.text, Some(&r.version)).unwrap();
        assert!(!o.written, "{nombre}: no debía escribir");
        assert_eq!(fs::read(&p).unwrap(), bytes, "{nombre}: bytes");
        assert_eq!(fs::metadata(&p).unwrap().modified().unwrap(), mtime, "{nombre}: mtime");
    }
}

#[test]
fn editar_en_el_medio_cambia_exactamente_esos_bytes() {
    for (nombre, bytes, ..) in casos() {
        let (d, p) = proyecto(&bytes);
        let r = fsio::read_file(d.path(), "a.tex").unwrap();
        let editado = r.text.replace("dos", "DOS y más");
        let o = fsio::write_file(d.path(), "a.tex", &editado, Some(&r.version)).unwrap();
        assert!(o.written, "{nombre}");
        // Esperado, calculado sobre los bytes originales y sin pasar por el código que se prueba.
        let esperado = reemplazar(&bytes, b"dos", "DOS y más".as_bytes());
        assert_eq!(fs::read(&p).unwrap(), esperado, "{nombre}: bytes después de editar");
        assert_eq!(o.version, fsio::version_of(&esperado), "{nombre}: versión devuelta");
    }
}

#[test]
fn vacio_y_solo_bom() {
    let (d, p) = proyecto(b"");
    let r = fsio::read_file(d.path(), "a.tex").unwrap();
    assert_eq!((r.text.as_str(), r.eol, r.bom, r.mixed), ("", Eol::Lf, false, false));
    fsio::write_file(d.path(), "a.tex", "x", Some(&r.version)).unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"x");

    let (d, p) = proyecto(&BOM);
    let r = fsio::read_file(d.path(), "a.tex").unwrap();
    assert_eq!((r.text.as_str(), r.bom), ("", true));
    let o = fsio::write_file(d.path(), "a.tex", "", Some(&r.version)).unwrap();
    assert!(!o.written);
    fsio::write_file(d.path(), "a.tex", "x", Some(&r.version)).unwrap();
    assert_eq!(fs::read(&p).unwrap(), con_bom(b"x"));
}

#[test]
fn eol_mezclados_se_marcan_y_al_guardar_siguen_al_dominante() {
    let casos: [(&str, &[u8], Eol); 2] = [
        ("crlf y lf", b"uno\r\ndos\ntres\r\n", Eol::Crlf),
        ("cr suelto dentro de crlf", b"uno\r\ndos\rtres\r\n", Eol::Crlf),
    ];
    for (nombre, bytes, dominante) in casos {
        let (d, p) = proyecto(bytes);
        let r = fsio::read_file(d.path(), "a.tex").unwrap();
        assert!(r.mixed, "{nombre}: tiene que marcarse como mezclado");
        assert_eq!(r.eol, dominante, "{nombre}: dominante");
        assert_eq!(r.text, "uno\ndos\ntres\n", "{nombre}: texto normalizado");
        // El editor lo abre en sólo lectura. Si el usuario acepta normalizar, se guarda con el dominante.
        fsio::write_file(d.path(), "a.tex", "uno\ndos\ntres!\n", Some(&r.version)).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"uno\r\ndos\r\ntres!\r\n", "{nombre}");
    }
}

#[test]
fn rechaza_lo_que_no_es_utf8() {
    let invalidos: [(&str, &[u8]); 4] = [
        ("utf8 inválido", b"abc\xFF\xFEdef"),
        ("utf16 le con bom", &[0xFF, 0xFE, b'a', 0, b'\n', 0]),
        ("utf16 be con bom", &[0xFE, 0xFF, 0, b'a']),
        ("nul", b"ab\0cd"),
    ];
    for (nombre, bytes) in invalidos {
        let (d, p) = proyecto(bytes);
        assert!(matches!(fsio::read_file(d.path(), "a.tex"), Err(Error::NotText(_))), "{nombre}: leer");
        // Tampoco se puede escribir encima: no se sabe cuál es su formato.
        assert!(
            matches!(fsio::write_file(d.path(), "a.tex", "x", Some(&fsio::version_of(bytes))), Err(Error::NotText(_))),
            "{nombre}: escribir"
        );
        assert_eq!(fs::read(&p).unwrap(), bytes, "{nombre}: el archivo no se toca");
    }
}

#[test]
fn rechaza_texto_con_cr() {
    let (d, p) = proyecto(b"uno\n");
    let r = fsio::read_file(d.path(), "a.tex").unwrap();
    for malo in ["a\r\nb", "a\rb", "\r"] {
        assert!(matches!(fsio::write_file(d.path(), "a.tex", malo, Some(&r.version)), Err(Error::InvalidText(_))));
    }
    assert_eq!(fs::read(&p).unwrap(), b"uno\n");
}

#[test]
fn conflicto_de_version() {
    let (d, p) = proyecto(b"uno\n");
    let r = fsio::read_file(d.path(), "a.tex").unwrap();
    fs::write(&p, b"cambiado afuera\n").unwrap();
    match fsio::write_file(d.path(), "a.tex", "mi cambio\n", Some(&r.version)) {
        Err(Error::Conflict { disk_version }) => assert_eq!(disk_version, fsio::version_of(b"cambiado afuera\n")),
        otro => panic!("tenía que ser Conflict: {otro:?}"),
    }
    assert_eq!(fs::read(&p).unwrap(), b"cambiado afuera\n", "no se pisa");
    // Sin versión tampoco se pisa un archivo que existe.
    assert!(matches!(fsio::write_file(d.path(), "a.tex", "x\n", None), Err(Error::Conflict { .. })));
    // Para sobrescribir a propósito se vuelve a escribir con la versión que informó el conflicto.
    let v = fsio::version_of(b"cambiado afuera\n");
    assert!(fsio::write_file(d.path(), "a.tex", "mi cambio\n", Some(&v)).unwrap().written);
}

#[test]
fn archivo_nuevo_se_crea_con_lf_y_sin_bom() {
    let d = TempDir::new().unwrap();
    let o = fsio::write_file(d.path(), "nuevo.tex", "hola\nmundo\n", None).unwrap();
    assert!(o.written);
    assert_eq!(fs::read(d.path().join("nuevo.tex")).unwrap(), b"hola\nmundo\n");
    // Con versión esperada sobre un archivo que no existe: alguien lo borró.
    assert!(matches!(fsio::write_file(d.path(), "otro.tex", "x", Some("abc")), Err(Error::Conflict { .. })));
    // Y en una carpeta que no existe no se crea nada.
    assert!(matches!(fsio::write_file(d.path(), "no/existe.tex", "x", None), Err(Error::NotFound(_))));
}

#[test]
fn archivo_de_solo_lectura_da_error_y_no_deja_temporales() {
    let (d, p) = proyecto(b"uno\n");
    let r = fsio::read_file(d.path(), "a.tex").unwrap();
    let mut perm = fs::metadata(&p).unwrap().permissions();
    perm.set_readonly(true);
    fs::set_permissions(&p, perm.clone()).unwrap();
    let res = fsio::write_file(d.path(), "a.tex", "otro\n", Some(&r.version));
    perm.set_readonly(false);
    fs::set_permissions(&p, perm).unwrap();
    assert!(matches!(res, Err(Error::Io(_))), "{res:?}");
    assert_eq!(fs::read(&p).unwrap(), b"uno\n");
    let sobras: Vec<_> = fs::read_dir(d.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with(".lvtmp"))
        .collect();
    assert!(sobras.is_empty(), "quedó un temporal: {sobras:?}");
}

#[cfg(windows)]
#[test]
fn guardar_con_el_archivo_abierto_por_otro_reintenta_y_termina() {
    use std::os::windows::fs::OpenOptionsExt;
    let (d, p) = proyecto(b"uno\ndos\n");
    let r = fsio::read_file(d.path(), "a.tex").unwrap();
    // FILE_SHARE_READ sin FILE_SHARE_DELETE: como pdflatex leyendo un \input. El rename falla hasta que lo suelta.
    let abierto = fs::OpenOptions::new().read(true).share_mode(1).open(&p).unwrap();
    let hilo = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        drop(abierto);
    });
    let t = std::time::Instant::now();
    let o = fsio::write_file(d.path(), "a.tex", "uno\nDOS\n", Some(&r.version)).unwrap();
    hilo.join().unwrap();
    assert!(o.written);
    assert!(t.elapsed() >= std::time::Duration::from_millis(300), "tenía que haber esperado al otro");
    assert_eq!(fs::read(&p).unwrap(), b"uno\nDOS\n");
}

#[test]
fn rutas_maliciosas_se_rechazan() {
    let (d, _) = proyecto(b"uno\n");
    let malas = [
        "", "/abs", "C:foo", "C:\\x", "\\\\srv\\share\\f", "a\\b", "../x", "a/../b", "a//b", "./a", "a.tex:ads", "CON",
        "nul.tex", "dir/COM1.txt", "a.", "a ", "x\0y", "..",
    ];
    for rel in malas {
        assert!(matches!(fsio::read_file(d.path(), rel), Err(Error::InvalidPath(_))), "leer {rel:?}");
        assert!(matches!(fsio::write_file(d.path(), rel, "x", None), Err(Error::InvalidPath(_))), "escribir {rel:?}");
    }
    // Una ruta normal, con espacios y tildes, sí.
    fs::create_dir_all(d.path().join("Secciones")).unwrap();
    fs::write(d.path().join("Secciones").join("Aproximación de Cauer.tex"), b"x").unwrap();
    assert!(fsio::read_file(d.path(), "Secciones/Aproximación de Cauer.tex").is_ok());
}

#[cfg(windows)]
#[test]
fn una_junction_que_apunta_afuera_se_rechaza() {
    let afuera = TempDir::new().unwrap();
    fs::write(afuera.path().join("secreto.tex"), b"x").unwrap();
    let (d, _) = proyecto(b"uno\n");
    let enlace = d.path().join("enlace");
    let ok = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&enlace)
        .arg(afuera.path())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    assert!(ok, "no se pudo crear la junction de prueba");
    assert!(matches!(fsio::read_file(d.path(), "enlace/secreto.tex"), Err(Error::InvalidPath(_))));
    assert!(matches!(fsio::write_file(d.path(), "enlace/nuevo.tex", "x", None), Err(Error::InvalidPath(_))));
    // Se borra la junction sin tocar lo de afuera.
    fs::remove_dir(&enlace).unwrap();
    assert!(afuera.path().join("secreto.tex").exists());
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

/// Todos los archivos de texto que existan: codificar(decodificar(x)) tiene que dar x byte a byte.
fn recorrer(dir: &Path, salida: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let nombre = e.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            if !["figuras-cache", ".lv", ".git", "Apuntes", "Sources", "_Revisar", "output_visualizations", "Pictures", "Imagenes"].contains(&nombre.as_str()) {
                recorrer(&p, salida);
            }
        } else if matches!(p.extension().and_then(|x| x.to_str()), Some("tex" | "bib" | "ist" | "md")) {
            salida.push(p);
        }
    }
}

#[test]
fn codificar_de_decodificar_devuelve_los_mismos_bytes_en_los_fixtures() {
    let mut vistos = 0;
    for carpeta in ["fixtures/libro-include", "fixtures/articulo-simple", "fixtures/biblio-indice", "fixtures/libro-tc"] {
        let mut archivos = vec![];
        recorrer(&repo().join(carpeta), &mut archivos);
        for f in archivos {
            let bytes = fs::read(&f).unwrap();
            let (texto, formato) = fsio::decodificar(&bytes).unwrap_or_else(|e| panic!("{}: {e}", f.display()));
            if formato.mixed {
                continue; // los mezclados no son idénticos a propósito
            }
            assert_eq!(fsio::codificar(&texto, formato).unwrap(), bytes, "{}", f.display());
            vistos += 1;
        }
    }
    assert!(vistos >= 10, "se esperaban al menos los fixtures: {vistos}");
}

#[test]
fn libro_include_es_crlf_y_coincide_con_lo_commiteado() {
    let dir = repo().join("fixtures").join("libro-include");
    let mut archivos = vec![];
    recorrer(&dir, &mut archivos);
    let tex: Vec<_> = archivos.iter().filter(|f| f.extension().is_some_and(|e| e == "tex")).collect();
    assert!(tex.len() >= 4);
    let copia = TempDir::new().unwrap();
    for f in tex {
        let rel = f.strip_prefix(&dir).unwrap().to_string_lossy().replace('\\', "/");
        let bytes = fs::read(f).unwrap();
        let (_, formato) = fsio::decodificar(&bytes).unwrap();
        assert_eq!(formato, Format { eol: Eol::Crlf, bom: false, mixed: false }, "{rel}");
        // Lo que git guardó (`-text` en .gitattributes: sin conversión) tiene que ser lo mismo que hay en disco.
        let git = std::process::Command::new("git")
            .current_dir(repo())
            .args(["show", &format!("HEAD:fixtures/libro-include/{rel}")])
            .output();
        if let Ok(g) = git {
            if g.status.success() {
                assert_eq!(g.stdout, bytes, "{rel}: el blob de git difiere del disco");
            }
        }
        // Ida y vuelta sobre una copia.
        let destino = copia.path().join(&rel);
        fs::create_dir_all(destino.parent().unwrap()).unwrap();
        fs::write(&destino, &bytes).unwrap();
        let r = fsio::read_file(copia.path(), &rel).unwrap();
        let o = fsio::write_file(copia.path(), &rel, &r.text, Some(&r.version)).unwrap();
        assert!(!o.written, "{rel}");
        assert_eq!(fs::read(&destino).unwrap(), bytes, "{rel}");
    }
}
