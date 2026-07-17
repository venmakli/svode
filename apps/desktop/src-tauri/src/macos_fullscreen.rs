use std::cell::RefCell;
use std::ffi::c_void;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject};
use objc2_app_kit::{
    NSWindow, NSWindowButton, NSWindowDidEnterFullScreenNotification,
    NSWindowDidExitFullScreenNotification, NSWindowWillEnterFullScreenNotification,
    NSWindowWillExitFullScreenNotification,
};
use objc2_foundation::{NSNotification, NSNotificationCenter};
use tauri::{AppHandle, Emitter, EventTarget, Manager};

const EVENT_TRAFFIC_LIGHT_INSET: &str = "native-window:traffic-light-inset";

#[derive(Clone, Copy)]
enum FullscreenPhase {
    Entering,
    Fullscreen,
    Exiting,
    Windowed,
}

impl FullscreenPhase {
    fn reserve_traffic_light_inset(self) -> bool {
        matches!(self, Self::Exiting | Self::Windowed)
    }
}

thread_local! {
    // These process-lifetime observers intentionally stay registered on
    // AppKit's main thread until the application exits.
    static OBSERVERS: RefCell<Vec<Retained<AnyObject>>> = const { RefCell::new(Vec::new()) };
}

pub(crate) fn install(app: &AppHandle) {
    OBSERVERS.with(|observers| {
        let mut observers = observers.borrow_mut();
        if !observers.is_empty() {
            return;
        }

        let center = NSNotificationCenter::defaultCenter();
        let notifications = unsafe {
            [
                (
                    NSWindowWillEnterFullScreenNotification,
                    FullscreenPhase::Entering,
                ),
                (
                    NSWindowDidEnterFullScreenNotification,
                    FullscreenPhase::Fullscreen,
                ),
                (
                    NSWindowWillExitFullScreenNotification,
                    FullscreenPhase::Exiting,
                ),
                (
                    NSWindowDidExitFullScreenNotification,
                    FullscreenPhase::Windowed,
                ),
            ]
        };

        for (name, phase) in notifications {
            let app = app.clone();
            let block = RcBlock::new(move |notification: NonNull<NSNotification>| {
                // SAFETY: NSNotificationCenter supplies a valid notification
                // for the duration of this callback.
                handle_notification(&app, unsafe { notification.as_ref() }, phase);
            });

            // SAFETY: AppKit fullscreen notifications are posted on its main
            // thread, the block has the required signature, and its captured
            // AppHandle plus Copy phase are safe to retain for the app lifetime.
            let token: Retained<AnyObject> = unsafe {
                center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
            }
            .into();
            observers.push(token);
        }
    });
}

fn handle_notification(app: &AppHandle, notification: &NSNotification, phase: FullscreenPhase) {
    let Some(object) = notification.object() else {
        return;
    };
    let Ok(ns_window) = object.downcast::<NSWindow>() else {
        return;
    };
    let native_window = Retained::as_ptr(&ns_window).cast::<c_void>().cast_mut();

    let Some(window_label) = app
        .webview_windows()
        .into_iter()
        .find_map(|(label, window)| {
            matches!(window.ns_window(), Ok(candidate) if candidate == native_window)
                .then_some(label)
        })
    else {
        return;
    };

    match phase {
        FullscreenPhase::Exiting => set_traffic_lights_hidden(&ns_window, true),
        FullscreenPhase::Windowed => set_traffic_lights_hidden(&ns_window, false),
        FullscreenPhase::Entering | FullscreenPhase::Fullscreen => {}
    }

    if let Err(error) = app.emit_to(
        EventTarget::window(window_label.clone()),
        EVENT_TRAFFIC_LIGHT_INSET,
        phase.reserve_traffic_light_inset(),
    ) {
        tracing::warn!(
            window = window_label,
            "failed to emit macOS traffic-light inset: {error}"
        );
    }
}

fn set_traffic_lights_hidden(window: &NSWindow, hidden: bool) {
    for button in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        if let Some(button) = window.standardWindowButton(button) {
            button.setHidden(hidden);
        }
    }
}
