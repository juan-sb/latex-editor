//! Ayudas compartidas por los tests de build: un sumidero de eventos que espera el `Finished`.
#![allow(dead_code)]

use lv_core::build::{BuildEvent, Sink};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct Recolector {
    pub eventos: Arc<Mutex<Vec<BuildEvent>>>,
    pub sink: Sink,
    terminado: Receiver<BuildEvent>,
}

impl Recolector {
    pub fn nuevo() -> Self {
        let eventos = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let e2 = eventos.clone();
        let sink: Sink = Arc::new(move |ev: BuildEvent| {
            if matches!(ev, BuildEvent::Finished { .. }) {
                let _ = tx.lock().unwrap().send(ev.clone());
            }
            e2.lock().unwrap().push(ev);
        });
        Recolector { eventos, sink, terminado: rx }
    }

    /// Espera el `Finished` o falla si no llega en `segundos`.
    pub fn esperar(&self, segundos: u64) -> BuildEvent {
        self.terminado
            .recv_timeout(Duration::from_secs(segundos))
            .unwrap_or_else(|_| panic!("el build no terminó en {segundos} s"))
    }

    pub fn log(&self) -> String {
        self.eventos
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| if let BuildEvent::Log { text, .. } = e { Some(text.as_str()) } else { None })
            .collect()
    }

    pub fn cantidad_de_logs(&self) -> usize {
        self.eventos.lock().unwrap().iter().filter(|e| matches!(e, BuildEvent::Log { .. })).count()
    }
}
