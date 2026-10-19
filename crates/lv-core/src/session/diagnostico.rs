//! El doctor y los procesos huérfanos de la sesión (9 y 5.6 del plan, F8). Los chequeos están en `doctor.rs` y `procesos.rs`; acá se
//! juntan con lo que sólo la sesión sabe: la configuración, el índice, el historial, el candado y si la cola está ocupada.

use super::*;
use crate::doctor::{self, EntradaDeProyecto, Hallazgo, Informe, Necesidades};
use crate::graph::EdgeKind;
use crate::procesos::{self, ProcesoTex};
use std::time::Instant;

impl Session {
    /// Corre todos los chequeos (lanza `pdflatex`, `latexmk`, `perl`... por unos segundos; no cambia nada). No toma el candado de los
    /// datos mientras lanza procesos: una compilación en curso no se frena.
    pub fn doctor(&self) -> Result<Informe> {
        self.doctor_con(&doctor::sonda_real)
    }

    pub fn doctor_con(&self, sonda: &doctor::Sonda) -> Result<Informe> {
        let t0 = Instant::now();
        let mut hallazgos = Vec::new();
        let (engine, externaliza, usa_biber, usa_bibtex, usa_makeindex);
        let latexmkrc = self.root.join("latexmkrc").is_file() || self.root.join(".latexmkrc").is_file();
        {
            let d = self.lock()?;
            let (Some(cfg), Some(ix), Some(rf)) = (d.config.as_ref(), d.index.as_ref(), d.root_file.as_ref()) else {
                // Sin raíz no hay proyecto que mirar: sólo la máquina.
                drop(d);
                let (h, distro) = doctor::chequeos_de_herramientas(
                    &Necesidades { engine: "pdflatex", externaliza: false, usa_biber: false, usa_bibtex: false, usa_makeindex: false, latexmkrc: false },
                    sonda,
                );
                return Ok(self.informe(h, distro, t0));
            };
            engine = cfg.engine.clone();
            externaliza = cfg.profiles.values().any(|p| p.externalize);
            let comandos: Vec<&str> = ix.files.values().flatten().filter(|e| e.kind == EdgeKind::Bib).map(|e| e.command.as_str()).collect();
            usa_biber = comandos.contains(&"addbibresource");
            usa_bibtex = comandos.contains(&"bibliography");
            usa_makeindex = ix.reachable.iter().filter(|r| r.to_ascii_lowercase().ends_with(".tex")).any(|rel| {
                std::fs::read_to_string(self.root.join(rel)).is_ok_and(|t| t.lines().any(|l| {
                    let l = crate::graph::sin_comentario(l);
                    l.contains("\\makeindex") || l.contains("\\printindex")
                }))
            });
            hallazgos.extend(doctor::chequeos_de_proyecto(&EntradaDeProyecto { root: &self.root, root_file: rf, config: cfg, ix }));
        }
        let (h, distro) = doctor::chequeos_de_herramientas(&Necesidades { engine: &engine, externaliza, usa_biber, usa_bibtex, usa_makeindex, latexmkrc }, sonda);
        hallazgos.extend(h);
        // Procesos: sólo si la cola está quieta (si no, los de TeX del proyecto son los nuestros).
        hallazgos.extend(doctor::chequeo_de_procesos(&self.huerfanos(), self.bloqueado_por));
        let hist: Vec<historial::Entrada> = historial::leer(&self.root, 20);
        hallazgos.extend(doctor::chequeo_de_coccion(&hist));
        Ok(self.informe(hallazgos, distro, t0))
    }

    fn informe(&self, mut hallazgos: Vec<Hallazgo>, distribucion: Option<String>, t0: Instant) -> Informe {
        doctor::ordenar(&mut hallazgos);
        Informe { hallazgos, ms: t0.elapsed().as_millis() as u64, distribucion }
    }

    /// Los procesos de TeX de este proyecto que quedaron de antes. Vacío si la cola está corriendo algo (serían los propios) o si el
    /// proyecto lo tiene otra instancia (los procesos son de ella).
    pub fn huerfanos(&self) -> Vec<ProcesoTex> {
        if self.cola.ocupado() || self.bloqueado_por.is_some() {
            return vec![];
        }
        procesos::de_tex_en(&self.root)
    }

    /// Mata los huérfanos pedidos y todo lo que lanzaron. Sólo los que siguen siendo huérfanos ahora: un PID que se reusó para otra
    /// cosa, o un proceso que ya terminó, no se toca. Devuelve los que se mataron.
    pub fn matar_huerfanos(&self, pids: &[u32]) -> Result<Vec<u32>> {
        self.guardia()?;
        let vigentes = self.huerfanos();
        let mut muertos = Vec::new();
        for p in vigentes.iter().filter(|p| pids.contains(&p.pid)) {
            if procesos::matar_arbol(p.pid) {
                muertos.push(p.pid);
            }
        }
        Ok(muertos)
    }
}
