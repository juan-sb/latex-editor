//! La cola de trabajos de una sesión: **un solo ejecutor** para todo lo que escribe en el proyecto (builds de latexmk,
//! cocción de figuras y, en F7, exportar y fragmentos). Dos trabajos a la vez escribirían los mismos auxiliares o las mismas
//! figuras, así que hay un solo "ocupado" para toda la sesión (5.6 y 7 del plan, revisión previa a F6).
//!
//! Reglas, las mismas de F2 con un tipo más:
//! - Con el ejecutor libre, un pedido corre en el acto.
//! - Con el ejecutor ocupado, el pedido queda **pendiente**. Hay a lo sumo un pendiente por clase y un pedido nuevo de
//!   la misma clase reemplaza al anterior (gana el último: guardar tres veces seguidas es un solo build).
//! - Al terminar el activo corre primero el pendiente de build y después el de cocción: un build es lo que el usuario está
//!   esperando; la cocción cede el paso.
//! - Cancelar descarta los pendientes (cancelar el trabajo activo es cosa de quien lo corre).
//!
//! La cola no lanza nada: decide quién sigue. Es genérica sobre el trabajo para probarla sin procesos.

use std::sync::{Mutex, MutexGuard};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Clase {
    Build,
    Bake,
}

/// Lo que la cola necesita saber de un trabajo.
pub trait Trabajo {
    fn clase(&self) -> Clase;
}

/// Qué hacer con un pedido.
#[derive(Debug, PartialEq, Eq)]
pub enum Pedido<J> {
    /// El ejecutor estaba libre y ahora es de este trabajo: hay que lanzarlo.
    Correr(J),
    /// Había otro trabajo corriendo: quedó pendiente (o reemplazó a uno de su clase).
    Encolado,
}

struct Estado<J> {
    activo: Option<Clase>,
    build: Option<J>,
    bake: Option<J>,
}

pub struct Cola<J> {
    e: Mutex<Estado<J>>,
}

impl<J: Trabajo> Default for Cola<J> {
    fn default() -> Self {
        Self::new()
    }
}

impl<J: Trabajo> Cola<J> {
    pub fn new() -> Self {
        Cola { e: Mutex::new(Estado { activo: None, build: None, bake: None }) }
    }

    fn lock(&self) -> MutexGuard<'_, Estado<J>> {
        // Un pánico de otro hilo no tiene que dejar la cola inutilizable para siempre.
        self.e.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn pedir(&self, trabajo: J) -> Pedido<J> {
        let mut e = self.lock();
        if e.activo.is_some() {
            match trabajo.clase() {
                Clase::Build => e.build = Some(trabajo),
                Clase::Bake => e.bake = Some(trabajo),
            }
            return Pedido::Encolado;
        }
        e.activo = Some(trabajo.clase());
        Pedido::Correr(trabajo)
    }

    /// El activo terminó (o no pudo lanzarse). Devuelve el que sigue, que ya queda como activo, o `None` si el ejecutor
    /// quedó libre. Se llama **antes** de avisar que el trabajo terminó: quien mira `ocupado` después del aviso ve la verdad.
    pub fn liberar(&self) -> Option<J> {
        let mut e = self.lock();
        let siguiente = e.build.take().or_else(|| e.bake.take());
        e.activo = siguiente.as_ref().map(Trabajo::clase);
        siguiente
    }

    /// Descarta los pendientes. Devuelve si había alguno.
    pub fn descartar(&self) -> bool {
        let mut e = self.lock();
        let habia = e.build.is_some() || e.bake.is_some();
        e.build = None;
        e.bake = None;
        habia
    }

    pub fn ocupado(&self) -> bool {
        self.lock().activo.is_some()
    }

    pub fn activo(&self) -> Option<Clase> {
        self.lock().activo
    }

    /// ¿Hay un pedido de build esperando? La cocción lo mira para ceder el paso entre figura y figura.
    pub fn build_pendiente(&self) -> bool {
        self.lock().build.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, Eq)]
    struct T(Clase, &'static str);
    impl Trabajo for T {
        fn clase(&self) -> Clase {
            self.0
        }
    }
    const B: Clase = Clase::Build;
    const C: Clase = Clase::Bake;

    #[test]
    fn libre_corre_en_el_acto_y_queda_ocupado() {
        let c = Cola::new();
        assert!(!c.ocupado());
        assert_eq!(c.pedir(T(B, "a")), Pedido::Correr(T(B, "a")));
        assert!(c.ocupado());
        assert_eq!(c.activo(), Some(B));
    }

    #[test]
    fn ocupado_deja_pendiente_y_los_de_la_misma_clase_se_coalescen_ganando_el_ultimo() {
        let c = Cola::new();
        c.pedir(T(B, "a"));
        assert_eq!(c.pedir(T(B, "b")), Pedido::Encolado);
        assert_eq!(c.pedir(T(B, "c")), Pedido::Encolado);
        assert_eq!(c.liberar(), Some(T(B, "c")));
        assert_eq!(c.activo(), Some(B), "el que sigue ya es el activo: no hay hueco en el que se cuele otro pedido");
        assert_eq!(c.liberar(), None);
        assert!(!c.ocupado());
    }

    #[test]
    fn una_coccion_activa_deja_pendiente_un_build_y_un_build_activo_deja_pendiente_una_coccion() {
        let c = Cola::new();
        assert_eq!(c.pedir(T(C, "cocer")), Pedido::Correr(T(C, "cocer")));
        assert_eq!(c.pedir(T(B, "build")), Pedido::Encolado);
        assert!(c.build_pendiente());
        assert_eq!(c.liberar(), Some(T(B, "build")));
        assert_eq!(c.pedir(T(C, "otra")), Pedido::Encolado);
        assert!(!c.build_pendiente());
        assert_eq!(c.liberar(), Some(T(C, "otra")));
        assert_eq!(c.liberar(), None);
    }

    #[test]
    fn un_build_pendiente_no_pisa_a_una_coccion_pendiente_ni_al_reves() {
        let c = Cola::new();
        c.pedir(T(B, "activo"));
        c.pedir(T(C, "cocer"));
        c.pedir(T(B, "build"));
        // Primero el build (lo que el usuario espera) y después la cocción, que cedió el paso.
        assert_eq!(c.liberar(), Some(T(B, "build")));
        assert_eq!(c.liberar(), Some(T(C, "cocer")));
        assert_eq!(c.liberar(), None);
    }

    #[test]
    fn descartar_saca_los_pendientes_pero_no_el_activo() {
        let c = Cola::new();
        assert!(!c.descartar());
        c.pedir(T(B, "a"));
        c.pedir(T(B, "b"));
        c.pedir(T(C, "c"));
        assert!(c.descartar());
        assert!(c.ocupado(), "el activo sigue: cancelarlo es de quien lo corre");
        assert_eq!(c.liberar(), None);
        assert!(!c.descartar());
    }

    #[test]
    fn liberar_sin_activo_es_inocuo() {
        let c: Cola<T> = Cola::new();
        assert_eq!(c.liberar(), None);
        assert!(!c.ocupado());
    }

    #[test]
    fn un_pedido_que_no_pudo_lanzarse_libera_el_ejecutor() {
        let c = Cola::new();
        assert!(matches!(c.pedir(T(B, "a")), Pedido::Correr(_)));
        // El lanzamiento falló: quien pidió libera, y el próximo pedido corre.
        assert_eq!(c.liberar(), None);
        assert!(matches!(c.pedir(T(B, "b")), Pedido::Correr(_)));
    }
}
