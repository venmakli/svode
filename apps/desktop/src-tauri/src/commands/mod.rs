pub mod app_variables;
pub mod files;
pub mod greet;
pub mod project_openers;
pub mod space;

use crate::error::AppError;

/// Runs work whose cost grows with the size of a folder or project on the
/// blocking pool, so a command doing it never holds the main thread that
/// drives the window. The work's own result comes back unchanged; only a
/// panic inside it turns into an error.
pub(crate) async fn off_main_thread<R: Send + 'static>(
    work: impl FnOnce() -> R + Send + 'static,
) -> Result<R, AppError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| AppError::General(format!("Background read failed: {error}")))
}

#[cfg(test)]
mod tests {
    use super::{files, off_main_thread, space};

    fn unpolled<F: std::future::Future + Send>(_command: F) {}

    /// Commands whose cost grows with a folder or the project are async, so
    /// Tauri does not run them on the main thread; the futures are created
    /// and dropped without running.
    #[test]
    fn data_sized_reads_are_async_commands() {
        let text = String::new;
        unpolled(files::list_tree_children(text(), None));
        unpolled(files::list_content_tree(text()));
        unpolled(files::get_page_detail_state(text(), text()));
        unpolled(files::read_tree_order(text()));
        unpolled(files::list_collections(text()));
        unpolled(files::query_relation_backlinks(text(), text(), None, None));
        unpolled(files::list_templates(text(), text()));
        unpolled(space::list_spaces(text()));
    }

    #[tokio::test]
    async fn work_runs_on_another_thread_and_returns_its_result() {
        let caller = std::thread::current().id();
        let (worker, value) = off_main_thread(|| (std::thread::current().id(), 42))
            .await
            .expect("work result");
        assert_ne!(worker, caller);
        assert_eq!(value, 42);
    }

    #[tokio::test]
    async fn a_panic_in_the_work_becomes_an_error() {
        let result = off_main_thread(|| -> u8 { panic!("boom") }).await;
        assert!(result.is_err());
    }
}
