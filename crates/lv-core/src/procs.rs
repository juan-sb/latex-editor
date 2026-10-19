//! Procesos: Job Objects de Windows (5.6 y 9 del plan).
//!
//! latexmk lanza perl, pdflatex, biber, makeindex... Cancelar tiene que matar todo el árbol. Con un Job Object el
//! sistema lo hace por nosotros y, con `KILL_ON_JOB_CLOSE`, también si la app muere sin cancelar: no queda un pdflatex
//! huérfano reteniendo el PDF. La asignación ocurre justo después del `spawn`, así que un hijo que latexmk lance en esos
//! primeros milisegundos puede escaparse; por eso cancelar sigue terminando con `taskkill /T` como respaldo.

#[cfg(windows)]
mod imp {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);

    // El handle de un Job Object se puede usar desde cualquier hilo.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> Option<Job> {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(h);
                    return None;
                }
                Some(Job(h))
            }
        }

        pub fn assign(&self, hijo: &std::process::Child) -> bool {
            unsafe { AssignProcessToJobObject(self.0, hijo.as_raw_handle() as HANDLE) != 0 }
        }

        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub struct Job;
    impl Job {
        /// Sin Job Objects: existe para que el código común compile; `assign` dice que no y quien llama mata los hijos a mano.
        pub fn new() -> Option<Job> {
            Some(Job)
        }
        pub fn assign(&self, _: &std::process::Child) -> bool {
            false
        }
        pub fn terminate(&self) {}
    }
}

pub use imp::Job;
