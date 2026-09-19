#[allow(dead_code)]
pub mod runtime;

pub use svode_core::agent_adapters::{
    AgentAdapterKind, SourceRegistryEnvironment, SourceRegistryError, resolve_executable_path,
    system_home_dir,
};

#[derive(Debug, Default, Clone, Copy)]
pub struct AgentAdapterRegistry;

pub fn system_source_registry_environment() -> Result<SourceRegistryEnvironment, crate::AppError> {
    svode_core::agent_adapters::system_source_registry_environment().map_err(|error| match error {
        SourceRegistryError::PathNotAccessible(message) => {
            crate::AppError::PathNotAccessible(message)
        }
    })
}
