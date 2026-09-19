use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

use crate::error::AppError;
use crate::git::cli::GitCli;
use svode_core::git::actor_sources::ActorSources;

enum Message {
    Event(notify::Result<Event>),
    Stop,
}

/// A Space owns the subscription; every signal is addressed to its resolved repository.
pub(crate) struct ActorObservation {
    sender: mpsc::Sender<Message>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for ActorObservation {
    fn drop(&mut self) {
        let _ = self.sender.send(Message::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl ActorObservation {
    pub fn start(
        cli: GitCli,
        space: PathBuf,
        invalidate: impl Fn(&Path) + Send + 'static,
    ) -> Result<Self, AppError> {
        let (sender, receiver) = mpsc::channel();
        let events = sender.clone();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = events.send(Message::Event(event));
        })
        .map_err(|error| AppError::Watcher(error.to_string()))?;
        // This anchor survives gitfile replacement and repository initialization/recovery.
        watcher
            .watch(&space, RecursiveMode::NonRecursive)
            .map_err(|error| AppError::Watcher(error.to_string()))?;
        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("actor observation runtime");
            let mut sources: Option<ActorSources> = None;
            let mut watched = BTreeMap::from([(space.clone(), false)]);
            let mut reconcile =
                |watcher: &mut RecommendedWatcher, sources: &mut Option<ActorSources>| match runtime
                    .block_on(ActorSources::resolve(cli.core(), &space))
                {
                    Ok(next) => {
                        let changed = sources.as_ref() != Some(&next);
                        let mut healthy = true;
                        let removed: Vec<_> = watched
                            .keys()
                            .filter(|path| !path.is_dir())
                            .cloned()
                            .collect();
                        for path in removed {
                            let _ = watcher.unwatch(&path);
                            watched.remove(&path);
                        }
                        let mut desired: BTreeMap<_, _> = next.watch_paths().into_iter().collect();
                        desired.insert(space.clone(), false);
                        for (path, recursive) in &desired {
                            if watched.get(path) == Some(recursive) {
                                continue;
                            }
                            match watcher.watch(
                                path,
                                if *recursive {
                                    RecursiveMode::Recursive
                                } else {
                                    RecursiveMode::NonRecursive
                                },
                            ) {
                                Ok(()) => {
                                    watched.insert(path.clone(), *recursive);
                                }
                                Err(error) => {
                                    healthy = false;
                                    tracing::warn!("actor source observation failed: {error}");
                                    invalidate(&next.repository);
                                }
                            }
                        }
                        let obsolete: Vec<_> = watched
                            .keys()
                            .filter(|path| !desired.contains_key(*path))
                            .cloned()
                            .collect();
                        for path in obsolete {
                            let _ = watcher.unwatch(&path);
                            watched.remove(&path);
                        }
                        if changed {
                            invalidate(&next.repository);
                        }
                        *sources = Some(next);
                        healthy
                    }
                    Err(error) => {
                        let stale: Vec<_> = watched
                            .keys()
                            .filter(|path| **path != space)
                            .cloned()
                            .collect();
                        for path in stale {
                            let _ = watcher.unwatch(&path);
                            watched.remove(&path);
                        }
                        if let Some(previous) = sources.as_ref() {
                            invalidate(&previous.repository);
                        }
                        tracing::warn!("actor source resolution failed: {error}");
                        false
                    }
                };
            let mut healthy = reconcile(&mut watcher, &mut sources);
            loop {
                let message = if healthy {
                    receiver
                        .recv()
                        .map_err(|_| mpsc::RecvTimeoutError::Disconnected)
                } else {
                    receiver.recv_timeout(Duration::from_secs(2))
                };
                let message = match message {
                    Ok(message) => message,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        healthy = reconcile(&mut watcher, &mut sources);
                        if healthy && let Some(source) = &sources {
                            invalidate(&source.repository);
                        }
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                };
                let mut relevant = false;
                let mut inspect = |message| match message {
                    Message::Stop => false,
                    Message::Event(event) => {
                        relevant |= match event {
                            Err(_) => true,
                            Ok(event) => {
                                !matches!(event.kind, notify::EventKind::Access(_))
                                    && event.paths.iter().any(|path| {
                                        sources.as_ref().is_none_or(|source| source.contains(path))
                                    })
                            }
                        };
                        true
                    }
                };
                if !inspect(message) {
                    return;
                }
                let deadline = std::time::Instant::now() + Duration::from_millis(200);
                while let Ok(message) = receiver
                    .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                {
                    if !inspect(message) {
                        return;
                    }
                    if std::time::Instant::now() >= deadline {
                        break;
                    }
                }
                if relevant {
                    if let Some(source) = &sources {
                        invalidate(&source.repository);
                    }
                    healthy = reconcile(&mut watcher, &mut sources);
                }
            }
        });
        Ok(Self {
            sender,
            thread: Some(thread),
        })
    }
}
