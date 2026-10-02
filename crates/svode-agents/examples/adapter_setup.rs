//! Live acceptance of adapter setup without Tauri: the setup facts, install
//! or update of the pinned adapter and its removal, through the same
//! library calls as the Desktop commands, into a directory of your choice.
//!
//! cargo run -p svode-agents --example adapter_setup -- \
//!     --root /tmp/svode-adapters --agent codex --install
//!
//! Without `--install` or `--remove` it only prints the setup facts. After
//! `--install` it prints the launch of the installed adapter for the user's
//! CLI; `live_turn --list` runs it without creating a session.

use std::path::PathBuf;

use svode_agents::adapters::{AdapterStore, RegistryPackageSource, adapter_pin, detect_node};
use svode_agents::registry::{AdapterRuntimeRegistry, AdapterTarget, SystemRuntimeCommandRunner};
use svode_core::agent_adapters::{AgentAdapterKind, system_home_dir};

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let mut root = None;
    let mut agent = None;
    let mut install = false;
    let mut remove = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--root" => root = Some(PathBuf::from(args.next().expect("--root value"))),
            "--agent" => {
                let id = args.next().expect("--agent value");
                agent = Some(
                    serde_json::from_value::<AgentAdapterKind>(serde_json::Value::String(id))
                        .expect("--agent codex | claude-code"),
                );
            }
            "--install" => install = true,
            "--remove" => remove = true,
            other => panic!("unknown argument {other}"),
        }
    }
    let store = AdapterStore::new(root.expect("--root"));
    let agent = agent.expect("--agent");
    let target = AdapterTarget {
        cwd: system_home_dir().expect("home"),
        search_path: std::env::var_os("PATH"),
    };
    let runner = SystemRuntimeCommandRunner;
    if install {
        let started = std::time::Instant::now();
        let result = store
            .install_adapter(agent, &target, &runner, &RegistryPackageSource::new())
            .await;
        println!("install: {result:?} in {:?}", started.elapsed());
    }
    if remove {
        println!("remove: {:?}", store.uninstall(agent).await);
    }
    let setup = store.agent_setup(agent, None, &target, &runner).await;
    println!("{}", serde_json::to_string_pretty(&setup).unwrap());
    let pin = adapter_pin(agent).expect("agent with an adapter");
    if let (Some(installed), Some(executable)) = (store.installed(pin), setup.cli.executable_path) {
        let node = detect_node(
            pin.node_major,
            &target.cwd,
            target.search_path.as_deref(),
            &runner,
        )
        .await
        .require(pin.node_major)
        .expect("node");
        let launch = AdapterRuntimeRegistry.acp_launch(
            agent,
            &node,
            &installed,
            &PathBuf::from(executable),
            &target.cwd,
        );
        println!(
            "launch: {} {} with {:?}",
            launch.program.display(),
            launch.args.join(" "),
            launch.env
        );
    }
}
