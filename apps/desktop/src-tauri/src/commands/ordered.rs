//! Commands whose calls take effect in the order the window made them.
//!
//! Only the main thread sees IPC calls in that order: a sync
//! `#[tauri::command]` would wait there for its work, and an async one starts
//! on a tokio worker in no fixed order. So these commands are dispatched by
//! hand: on the main thread their arguments are parsed as a
//! `#[tauri::command]` parses them, their work goes to the ordered executor
//! of its owner without waiting, and the call is answered once that work is
//! done, from a task that waits without holding a worker (DF-365 R2).

use std::future::Future;

use tauri::ipc::{CommandArg, CommandItem, Invoke, InvokeError, IpcResponse};
use tauri::{Runtime, Webview};

use crate::commands::space;
use crate::error::AppError;
use crate::terminal;

/// `tauri::generate_handler!` over the listed commands, with the ordered
/// commands dispatched by [`with_ordered_calls`].
macro_rules! ordered_handler {
    ($($commands:tt)*) => {
        $crate::commands::ordered::with_ordered_calls(::tauri::generate_handler![$($commands)*])
    };
}
pub(crate) use ordered_handler;

/// The generated command handler with the ordered commands dispatched by
/// hand; every other command goes to `commands`.
pub(crate) fn with_ordered_calls<R: Runtime>(
    commands: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let ordered: fn(Invoke<R>) = match invoke.message.command() {
            terminal::commands::TERMINAL_WRITE => terminal::commands::terminal_write,
            space::SET_APP_LOCALE => space::set_app_locale,
            space::SET_APP_THEME => space::set_app_theme,
            _ => return commands(invoke),
        };
        ordered(invoke);
        true
    }
}

/// An ordered call while it is being queued on the main thread.
pub(crate) struct Call<'a, R: Runtime> {
    name: &'static str,
    invoke: &'a Invoke<R>,
}

impl<'a, R: Runtime> Call<'a, R> {
    /// The argument `key`, parsed as for a `#[tauri::command]` named after
    /// the call.
    pub(crate) fn arg<T: CommandArg<'a, R>>(&self, key: &'static str) -> Result<T, InvokeError> {
        T::from_command(CommandItem {
            plugin: None,
            name: self.name,
            key,
            message: &self.invoke.message,
            acl: &self.invoke.acl,
        })
    }

    pub(crate) fn webview(&self) -> &'a Webview<R> {
        self.invoke.message.webview_ref()
    }
}

/// Runs `queue` for the command `name` now, on the main thread, and answers
/// the call with the result of the work it queued; an error while queueing
/// answers it at once.
pub(crate) fn answer<R, T, F>(
    invoke: Invoke<R>,
    name: &'static str,
    queue: impl FnOnce(Call<'_, R>) -> Result<F, InvokeError>,
) where
    R: Runtime,
    T: IpcResponse,
    F: Future<Output = Result<T, AppError>> + Send + 'static,
{
    let queued = queue(Call {
        name,
        invoke: &invoke,
    });
    match queued {
        Ok(done) => invoke
            .resolver
            .respond_async(async move { done.await.map_err(InvokeError::from) }),
        Err(error) => invoke.resolver.respond::<T>(Err(error)),
    }
}
