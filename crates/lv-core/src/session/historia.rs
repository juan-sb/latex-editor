//! El historial de la sesión (9 del plan, F8): arma y escribe la línea de cada trabajo de la cola cuando termina. La forma de la línea y
//! las pistas están en `historial.rs`; acá está lo que sólo la sesión sabe (qué lo pidió, qué faltaba al empezar, qué se invalidó).

use super::*;
use crate::historial::{self, Entrada, EntradaView, Herramienta, Listado, ParteExportada};
use std::time::Instant;

pub(super) fn ahora_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Lo que se sabe de un build desde que se lo pide hasta que termina. Lo llenan `lanzar` (qué lo pidió) y el `antes` del lanzamiento
/// (qué había en el disco al empezar) y lo lee `al_terminar`. Un reintento por `.aux` truncado comparte el mismo contexto: es una sola
/// línea del historial con `reparado`.
pub(super) struct CtxBuild {
    pub inicio_ms: u64,
    pub t0: Instant,
    pub motivo: String,
    pub listado: Option<Listado>,
    pub limpio_antes: bool,
    pub aux_faltantes: Vec<String>,
    pub sospechoso_antes: bool,
    pub otros_tex: u32,
    pub datos_cambiados: Vec<String>,
    /// Datos de figuras que la app veía por primera vez (sin registro previo): se invalidan por las dudas.
    pub datos_nuevos: Vec<String>,
    pub figuras_invalidadas: u32,
    pub reparado: bool,
}

impl CtxBuild {
    pub fn nuevo(motivo: String, listado: Option<Listado>) -> Self {
        CtxBuild {
            inicio_ms: ahora_ms(),
            t0: Instant::now(),
            motivo,
            listado,
            limpio_antes: false,
            aux_faltantes: vec![],
            sospechoso_antes: false,
            otros_tex: 0,
            datos_cambiados: vec![],
            datos_nuevos: vec![],
            figuras_invalidadas: 0,
            reparado: false,
        }
    }
}

pub(super) type Ctx = Arc<Mutex<CtxBuild>>;

/// Lo que dejó el listado de una cocción para su línea del historial.
#[derive(Default, Clone)]
pub(super) struct DetalleDeListado {
    pub listado_ms: u64,
    pub listadas: u32,
    pub a_cocinar: u32,
    pub datos_cambiados: Vec<String>,
    pub datos_nuevos: Vec<String>,
}

impl Session {
    /// Las últimas `limite` líneas del historial (la más nueva primero), con sus pistas.
    pub fn history(&self, limite: usize) -> Vec<EntradaView> {
        historial::leer(&self.root, limite).into_iter().map(historial::con_pistas).collect()
    }

    /// Qué pidió el build que va a empezar: lo último que se pidió (como la cola, gana el último), `manual` si nadie dijo nada.
    pub(super) fn tomar_motivo(&self) -> String {
        self.motivo.lock().ok().and_then(|mut m| m.take()).unwrap_or_else(|| "manual".into())
    }

    pub(super) fn tomar_listado(&self) -> Option<Listado> {
        self.listado_decidido.lock().ok().and_then(|mut l| l.take())
    }

    /// La línea de un build (o de la vista previa de un fragmento) que acaba de terminar.
    pub(super) fn registrar_build(&self, ev: &BuildEvent, perfil: &str, ctx: &Ctx) {
        let BuildEvent::Finished { ok, code, cancelled, ms, passes, repaired, errors, warnings, badboxes, figuras, herramientas, .. } = ev else { return };
        let Ok(c) = ctx.lock() else { return };
        let reparado = c.reparado || *repaired;
        historial::registrar(
            &self.root,
            &Entrada {
                inicio_ms: c.inicio_ms,
                tipo: if perfil == crate::config::PERFIL_FRAGMENTO { "fragment" } else { "build" }.into(),
                perfil: Some(perfil.to_string()),
                motivo: c.motivo.clone(),
                // Un build reparado son dos corridas de latexmk: se cuenta desde el pedido.
                ms: if reparado { c.t0.elapsed().as_millis() as u64 } else { *ms },
                ok: *ok,
                cancelado: *cancelled,
                codigo: *code,
                pasadas: *passes,
                herramientas: herramientas.iter().map(|(nombre, ms)| Herramienta { nombre: nombre.clone(), ms: *ms }).collect(),
                errores: *errors,
                avisos: *warnings,
                cajas: *badboxes,
                figuras_en_el_build: figuras.clone(),
                limpio_antes: c.limpio_antes,
                aux_faltantes: c.aux_faltantes.clone(),
                sospechoso_antes: c.sospechoso_antes,
                reparado,
                otros_tex: c.otros_tex,
                datos_cambiados: c.datos_cambiados.clone(),
                datos_nuevos: c.datos_nuevos.clone(),
                figuras_invalidadas: c.figuras_invalidadas,
                listado: c.listado.clone(),
                ..Default::default()
            },
        );
    }

    /// La línea de una cocción de figuras.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn registrar_bake(&self, inicio_ms: u64, ms: u64, b: &bake::BakeJob, trabajos: u32, detalle: &DetalleDeListado, fin: &BuildEvent) {
        let BuildEvent::BakeFinished { ok, cancelled, ceded, cooked, failed, remaining, error, .. } = fin else { return };
        let _ = error;
        historial::registrar(
            &self.root,
            &Entrada {
                inicio_ms,
                tipo: "bake".into(),
                perfil: match &b.fase {
                    bake::FaseBake::Perfil(p) => Some(p.clone()),
                    bake::FaseBake::Todo => None,
                },
                motivo: b.motivo.clone(),
                ms,
                ok: *ok,
                cancelado: *cancelled,
                fase: Some(b.fase.nombre()),
                listado_ms: detalle.listado_ms,
                figuras_listadas: detalle.listadas,
                a_cocinar: detalle.a_cocinar,
                cocidas: *cooked,
                fallidas: *failed,
                restantes: *remaining,
                cedio: *ceded,
                trabajos,
                datos_cambiados: detalle.datos_cambiados.clone(),
                datos_nuevos: detalle.datos_nuevos.clone(),
                ..Default::default()
            },
        );
    }

    /// La línea de una exportación.
    pub(super) fn registrar_export(&self, inicio_ms: u64, ms: u64, ok: bool, cancelado: bool, partes: Vec<ParteExportada>, destino: &str) {
        historial::registrar(
            &self.root,
            &Entrada {
                inicio_ms,
                tipo: "export".into(),
                perfil: Some(crate::config::PERFIL_EXPORT.into()),
                motivo: "manual".into(),
                ms,
                ok,
                cancelado,
                partes,
                destino: Some(destino.to_string()),
                ..Default::default()
            },
        );
    }
}
