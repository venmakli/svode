//! The OS permission to record (V2 `06`). Only macOS asks per app: there
//! a denied app records silence instead of failing, so the authorization
//! is checked, and asked for once, before capture opens. Windows and Linux
//! report a denial as a capture failure ([`super::capture::classify`]).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Granted,
    Denied,
}

#[cfg(target_os = "macos")]
pub async fn authorize() -> Access {
    macos::authorize().await
}

#[cfg(not(target_os = "macos"))]
pub async fn authorize() -> Access {
    Access::Granted
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::Mutex;

    use block2::RcBlock;
    use objc2::runtime::{AnyClass, Bool};
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    use super::Access;

    #[link(name = "AVFoundation", kind = "framework")]
    unsafe extern "C" {
        static AVMediaTypeAudio: &'static NSString;
    }

    // AVAuthorizationStatus
    const NOT_DETERMINED: isize = 0;
    const AUTHORIZED: isize = 3;

    fn capture_device() -> &'static AnyClass {
        class!(AVCaptureDevice)
    }

    fn status() -> isize {
        // SAFETY: a class method of AVCaptureDevice taking an AVMediaType
        // constant and returning an NSInteger.
        unsafe { msg_send![capture_device(), authorizationStatusForMediaType: AVMediaTypeAudio] }
    }

    fn request(sender: tokio::sync::oneshot::Sender<bool>) {
        let sender = Mutex::new(Some(sender));
        let handler = RcBlock::new(move |granted: Bool| {
            if let Some(sender) = sender.lock().expect("microphone answer lock").take() {
                let _ = sender.send(granted.as_bool());
            }
        });
        // SAFETY: the completion handler is a `void (^)(BOOL)` block, which
        // AVFoundation copies before returning.
        unsafe {
            let _: () = msg_send![
                capture_device(),
                requestAccessForMediaType: AVMediaTypeAudio,
                completionHandler: &*handler
            ];
        }
    }

    /// The current authorization; when undetermined, asks the system, which
    /// shows its prompt with `NSMicrophoneUsageDescription`.
    pub async fn authorize() -> Access {
        match status() {
            AUTHORIZED => return Access::Granted,
            NOT_DETERMINED => {}
            _ => return Access::Denied,
        }
        let (sender, answer) = tokio::sync::oneshot::channel();
        request(sender);
        match answer.await {
            Ok(true) => Access::Granted,
            _ => Access::Denied,
        }
    }
}
