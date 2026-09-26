//! Windows Shell lookups: the file association handlers Windows recommends for
//! a file type, their names and icons, and launching a chosen handler.
//!
//! Shell and WIC objects are apartment-threaded, so every lookup runs on its
//! own short-lived STA thread regardless of the calling thread.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, mpsc},
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use windows::{
    Win32::{
        Foundation::{S_OK, SIZE},
        Graphics::{
            Gdi::{DeleteObject, HBITMAP, HGDIOBJ, HPALETTE},
            Imaging::{
                CLSID_WICImagingFactory, GUID_ContainerFormatPng, GUID_WICPixelFormat32bppBGRA,
                IWICBitmapFrameEncode, IWICBitmapSource, IWICImagingFactory,
                WICBitmapDitherTypeNone, WICBitmapEncoderNoCache, WICBitmapPaletteTypeCustom,
                WICBitmapUsePremultipliedAlpha,
            },
        },
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
            CoTaskMemFree, CoUninitialize, IDataObject, IStream, STATFLAG_NONAME, STATSTG,
            STREAM_SEEK_SET,
        },
        UI::{
            Shell::{
                ASSOC_FILTER_RECOMMENDED, ASSOCF, ASSOCF_INIT_BYEXENAME, ASSOCF_INIT_IGNOREUNKNOWN,
                ASSOCSTR, ASSOCSTR_EXECUTABLE, ASSOCSTR_FRIENDLYAPPNAME, AssocQueryStringW,
                BHID_DataObject, IAssocHandler, IShellItem, IShellItemImageFactory,
                SHAssocEnumHandlers, SHCreateItemFromParsingName, SHCreateMemStream,
                SHDefExtractIconW, SHLoadIndirectString, SIGDN_NORMALDISPLAY, SIIGBF_BIGGERSIZEOK,
                SIIGBF_ICONONLY,
            },
            WindowsAndMessaging::{
                DestroyIcon, DispatchMessageW, HICON, MSG, PM_REMOVE, PeekMessageW,
                TranslateMessage,
            },
        },
    },
    core::{HSTRING, PCWSTR, PWSTR},
};

use super::{
    AppPresentation, ExternalOpenError, OfferedApp, default_handler_index, expand_env_vars,
    handler_app_id,
};

/// Pixel size of the delivered icon: sharp at ~20 px on high-DPI displays.
const ICON_PIXELS: u32 = 64;

/// Largest packaged-app logo delivered as is.
const MAX_LOGO_BYTES: u64 = 256 * 1024;

/// How long the launching STA keeps pumping messages so packaged handlers can
/// finish their activation.
const ACTIVATION_PUMP: Duration = Duration::from_millis(1500);

/// Presentation of each launch target and association handler for the
/// lifetime of the process.
static PRESENTATIONS: LazyLock<Mutex<HashMap<String, AppPresentation>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Name and icon of the first of `targets` (Shell parsing names: an executable
/// path or a packaged application in the Apps folder) the Shell can present.
pub(crate) fn app_presentation(targets: Vec<String>) -> AppPresentation {
    targets
        .into_iter()
        .find_map(|target| {
            let presentation = cached(format!("target:{target}"), || {
                on_sta(move || target_presentation(&target)).unwrap_or_default()
            });
            (presentation.label.is_some() || presentation.icon.is_some()).then_some(presentation)
        })
        .unwrap_or_default()
}

/// Handlers Windows recommends for the type of `file`, with the default one
/// marked. Identified by a digest of the handler name, never by its path.
pub(crate) fn offered_apps(file: &Path) -> Vec<OfferedApp> {
    let Some(extension) = file_type(file) else {
        return Vec::new();
    };
    // SAFETY: `on_sta` runs the lookup on an STA thread.
    on_sta(move || unsafe { offered_handlers(&extension) }).unwrap_or_default()
}

/// Invokes the handler behind `app` for `file` through the Shell, which also
/// activates packaged applications.
pub(crate) fn launch(app: &OfferedApp, file: &Path) -> Result<(), ExternalOpenError> {
    let extension = file_type(file).ok_or(ExternalOpenError::UnknownApp)?;
    let handler_name = app.location.to_string_lossy().into_owned();
    let file = file.to_path_buf();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _apartment = StaApartment::enter();
        // SAFETY: COM is initialized as STA on this thread for the whole call.
        let result = unsafe { invoke_handler(&extension, &handler_name, &file) };
        let launched = result.is_ok();
        let _ = sender.send(result);
        if launched {
            pump_messages(ACTIVATION_PUMP);
        }
    });
    receiver.recv().unwrap_or(Err(ExternalOpenError::Launch))
}

fn file_type(file: &Path) -> Option<String> {
    file.extension()
        .map(|extension| format!(".{}", extension.to_string_lossy().to_lowercase()))
}

fn cached(key: String, load: impl FnOnce() -> AppPresentation) -> AppPresentation {
    if let Some(presentation) = lock_presentations().get(&key) {
        return presentation.clone();
    }
    let presentation = load();
    lock_presentations().insert(key, presentation.clone());
    presentation
}

fn lock_presentations() -> std::sync::MutexGuard<'static, HashMap<String, AppPresentation>> {
    PRESENTATIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Runs `work` on a fresh STA thread and waits for its result.
fn on_sta<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    std::thread::spawn(move || {
        let _apartment = StaApartment::enter();
        work()
    })
    .join()
    .ok()
}

struct StaApartment {
    initialized: bool,
}

impl StaApartment {
    fn enter() -> Self {
        // SAFETY: plain COM initialization of the current thread; balanced in Drop.
        let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
        Self { initialized }
    }
}

impl Drop for StaApartment {
    fn drop(&mut self) {
        if self.initialized {
            // SAFETY: pairs the successful CoInitializeEx of this thread.
            unsafe { CoUninitialize() };
        }
    }
}

fn pump_messages(duration: Duration) {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        let mut message = MSG::default();
        // SAFETY: standard message loop over this thread's queue.
        unsafe {
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn target_presentation(target: &str) -> AppPresentation {
    // SAFETY: called on an STA thread; every returned COM string is freed.
    unsafe {
        let item: Option<IShellItem> =
            SHCreateItemFromParsingName(&HSTRING::from(target), None).ok();
        let label = if Path::new(target).is_file() {
            assoc_string(ASSOCF_INIT_BYEXENAME, ASSOCSTR_FRIENDLYAPPNAME, target)
        } else {
            item.as_ref()
                .and_then(|item| co_string(item.GetDisplayName(SIGDN_NORMALDISPLAY)))
        };
        AppPresentation {
            label: label.filter(|label| !label.trim().is_empty()),
            icon: shell_item_icon(target),
        }
    }
}

/// SAFETY: the caller runs on an STA thread.
unsafe fn offered_handlers(extension: &str) -> Vec<OfferedApp> {
    unsafe {
        let handlers = recommended_handlers(extension);
        let default_exe = assoc_string(ASSOCF_INIT_IGNOREUNKNOWN, ASSOCSTR_EXECUTABLE, extension);
        let default_label = assoc_string(
            ASSOCF_INIT_IGNOREUNKNOWN,
            ASSOCSTR_FRIENDLYAPPNAME,
            extension,
        );

        let named: Vec<(String, String)> = handlers
            .iter()
            .map(|(handler, name)| {
                let label = co_string(handler.GetUIName())
                    .filter(|label| !label.trim().is_empty())
                    .unwrap_or_else(|| executable_stem(name));
                (name.clone(), label)
            })
            .collect();
        let default = default_handler_index(
            named.iter().map(|(name, label)| (name, label)),
            default_exe.as_deref(),
            default_label.as_deref(),
        );

        handlers
            .iter()
            .zip(named)
            .enumerate()
            .map(|(index, ((handler, _), (name, label)))| {
                let icon = cached(format!("handler:{name}"), || AppPresentation {
                    label: None,
                    icon: handler_icon(handler, &name),
                })
                .icon;
                OfferedApp {
                    id: handler_app_id(&name),
                    label,
                    icon,
                    is_default: default == Some(index),
                    location: PathBuf::from(name),
                }
            })
            .collect()
    }
}

/// SAFETY: the caller runs on an STA thread.
unsafe fn recommended_handlers(extension: &str) -> Vec<(IAssocHandler, String)> {
    unsafe {
        let Ok(handlers) = SHAssocEnumHandlers(&HSTRING::from(extension), ASSOC_FILTER_RECOMMENDED)
        else {
            return Vec::new();
        };
        let mut found = Vec::new();
        loop {
            let mut batch: [Option<IAssocHandler>; 1] = [None];
            let mut fetched = 0;
            if handlers.Next(&mut batch, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            if let Some(handler) = batch[0].take()
                && let Some(name) = co_string(handler.GetName())
            {
                found.push((handler, name));
            }
        }
        found
    }
}

/// Re-enumerates the handlers for this file type and invokes the one still
/// registered under `handler_name`.
///
/// SAFETY: the caller runs on an STA thread.
unsafe fn invoke_handler(
    extension: &str,
    handler_name: &str,
    file: &Path,
) -> Result<(), ExternalOpenError> {
    unsafe {
        let handler = recommended_handlers(extension)
            .into_iter()
            .find(|(_, name)| name.eq_ignore_ascii_case(handler_name))
            .map(|(handler, _)| handler)
            .ok_or(ExternalOpenError::UnknownApp)?;
        let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(file.as_os_str()), None)
            .map_err(|_| ExternalOpenError::Launch)?;
        let data: IDataObject = item
            .BindToHandler(None, &BHID_DataObject)
            .map_err(|_| ExternalOpenError::Launch)?;
        handler.Invoke(&data).map_err(|_| ExternalOpenError::Launch)
    }
}

/// SAFETY: the caller runs on an STA thread.
unsafe fn handler_icon(handler: &IAssocHandler, name: &str) -> Option<String> {
    unsafe {
        let mut location = PWSTR::null();
        let mut index = 0;
        handler
            .GetIconLocation(&mut location, &mut index)
            .ok()
            .and_then(|()| co_string(Ok(location)))
            .and_then(|location| location_icon(&location, index))
            .or_else(|| shell_item_icon(name))
    }
}

/// Icon at a Shell icon location: an indirect packaged-app resource, a
/// `.png` file, or an icon resource of an executable/library/`.ico`.
///
/// SAFETY: the caller runs on an STA thread.
unsafe fn location_icon(location: &str, index: i32) -> Option<String> {
    unsafe {
        let (path, index) = if location.starts_with('@') {
            let mut resolved = vec![0u16; 1024];
            SHLoadIndirectString(&HSTRING::from(location), &mut resolved, None).ok()?;
            (from_wide(&resolved), 0)
        } else {
            (
                expand_env_vars(location, |name| std::env::var(name).ok()),
                index,
            )
        };
        if path.is_empty() {
            return None;
        }
        if Path::new(&path)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
        {
            return png_file_data_url(Path::new(&path));
        }
        extracted_icon(&path, index)
    }
}

fn png_file_data_url(path: &Path) -> Option<String> {
    let size = std::fs::metadata(path).ok()?.len();
    if size == 0 || size > MAX_LOGO_BYTES {
        return None;
    }
    std::fs::read(path).ok().map(|png| png_data_url(&png))
}

/// SAFETY: the caller runs on an STA thread.
unsafe fn extracted_icon(path: &str, index: i32) -> Option<String> {
    unsafe {
        let mut icon = HICON::default();
        let result = SHDefExtractIconW(
            &HSTRING::from(path),
            index,
            0,
            Some(&mut icon),
            None,
            ICON_PIXELS,
        );
        // S_FALSE means the file has no icon at this index.
        if result != S_OK || icon.is_invalid() {
            return None;
        }
        let png = wic_factory().and_then(|factory| {
            let bitmap = factory.CreateBitmapFromHICON(icon).ok()?;
            encode_png(&factory, &bitmap.into())
        });
        let _ = DestroyIcon(icon);
        png.map(|png| png_data_url(&png))
    }
}

/// The icon the Shell shows for a parsing name, including packaged
/// applications that have no icon resource of their own.
///
/// SAFETY: the caller runs on an STA thread.
unsafe fn shell_item_icon(target: &str) -> Option<String> {
    unsafe {
        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(&HSTRING::from(target), None).ok()?;
        let bitmap: HBITMAP = factory
            .GetImage(
                SIZE {
                    cx: ICON_PIXELS as i32,
                    cy: ICON_PIXELS as i32,
                },
                SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK,
            )
            .ok()?;
        // The Shell hands out icon bitmaps with premultiplied alpha.
        let png = wic_factory().and_then(|factory| {
            let source = factory
                .CreateBitmapFromHBITMAP(
                    bitmap,
                    HPALETTE::default(),
                    WICBitmapUsePremultipliedAlpha,
                )
                .ok()?;
            encode_png(&factory, &source.into())
        });
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        png.map(|png| png_data_url(&png))
    }
}

/// SAFETY: the caller runs on an STA thread.
unsafe fn wic_factory() -> Option<IWICImagingFactory> {
    unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok() }
}

/// Encodes `source` as a straight-alpha BGRA PNG.
///
/// SAFETY: the caller runs on an STA thread.
unsafe fn encode_png(factory: &IWICImagingFactory, source: &IWICBitmapSource) -> Option<Vec<u8>> {
    unsafe {
        let converter = factory.CreateFormatConverter().ok()?;
        converter
            .Initialize(
                source,
                &GUID_WICPixelFormat32bppBGRA,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .ok()?;
        let (mut width, mut height) = (0, 0);
        converter.GetSize(&mut width, &mut height).ok()?;

        let stream: IStream = SHCreateMemStream(None)?;
        let encoder = factory
            .CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null())
            .ok()?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache).ok()?;
        let mut frame: Option<IWICBitmapFrameEncode> = None;
        encoder
            .CreateNewFrame(&mut frame, std::ptr::null_mut())
            .ok()?;
        let frame = frame?;
        frame.Initialize(None).ok()?;
        frame.SetSize(width, height).ok()?;
        let mut format = GUID_WICPixelFormat32bppBGRA;
        frame.SetPixelFormat(&mut format).ok()?;
        frame.WriteSource(&converter, std::ptr::null()).ok()?;
        frame.Commit().ok()?;
        encoder.Commit().ok()?;

        let mut stat = STATSTG::default();
        stream.Stat(&mut stat, STATFLAG_NONAME).ok()?;
        let mut png = vec![0u8; usize::try_from(stat.cbSize).ok()?];
        stream.Seek(0, STREAM_SEEK_SET, None).ok()?;
        let mut read = 0;
        stream
            .Read(png.as_mut_ptr().cast(), png.len() as u32, Some(&mut read))
            .ok()
            .ok()?;
        png.truncate(read as usize);
        (!png.is_empty()).then_some(png)
    }
}

fn png_data_url(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", STANDARD.encode(png))
}

/// SAFETY: plain Shell association query.
unsafe fn assoc_string(flags: ASSOCF, kind: ASSOCSTR, assoc: &str) -> Option<String> {
    unsafe {
        let assoc = HSTRING::from(assoc);
        let mut length = 0u32;
        let _ = AssocQueryStringW(flags, kind, &assoc, PCWSTR::null(), None, &mut length);
        if length == 0 {
            return None;
        }
        let mut buffer = vec![0u16; length as usize];
        AssocQueryStringW(
            flags,
            kind,
            &assoc,
            PCWSTR::null(),
            Some(PWSTR(buffer.as_mut_ptr())),
            &mut length,
        )
        .ok()
        .ok()?;
        Some(from_wide(&buffer)).filter(|value| !value.is_empty())
    }
}

/// Takes ownership of a COM-allocated string.
///
/// SAFETY: `value` is a string allocated with the COM task allocator or null.
unsafe fn co_string(value: windows::core::Result<PWSTR>) -> Option<String> {
    unsafe {
        let value = value.ok()?;
        if value.is_null() {
            return None;
        }
        let text = value.to_string().ok();
        CoTaskMemFree(Some(value.0 as *const _));
        text.filter(|text| !text.is_empty())
    }
}

fn from_wide(buffer: &[u16]) -> String {
    let end = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

fn executable_stem(name: &str) -> String {
    Path::new(name)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string())
}
