use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use objc2::{AllocAnyThread, available};
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
use objc2_foundation::{
    NSBundle, NSDictionary, NSFileManager, NSPoint, NSRect, NSSize, NSString, NSURL,
};

use super::{AppPresentation, OfferedApp};

/// Pixel size of the delivered icon: sharp at ~20 px on Retina displays.
const ICON_PIXELS: f64 = 64.0;

/// Presentation of each installed bundle for the lifetime of the process.
static PRESENTATIONS: LazyLock<Mutex<HashMap<PathBuf, AppPresentation>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Finds an application bundle in the standard application folders.
pub(crate) fn find_app_bundle(app_name: &str) -> Option<PathBuf> {
    let app_bundle = format!("{app_name}.app");
    let mut candidates = vec![
        PathBuf::from("/Applications").join(&app_bundle),
        PathBuf::from("/Applications/Utilities").join(&app_bundle),
        PathBuf::from("/System/Applications").join(&app_bundle),
        PathBuf::from("/System/Applications/Utilities").join(&app_bundle),
    ];

    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join("Applications").join(&app_bundle));
    }

    candidates.into_iter().find(|path| path.exists())
}

/// Name and icon of the bundle that is launched for `bundle_names`, falling
/// back to Launch Services by bundle identifier.
pub(crate) fn app_presentation(bundle_names: &[&str], bundle_id: &str) -> AppPresentation {
    let Some(bundle) = bundle_names
        .iter()
        .find_map(|name| find_app_bundle(name))
        .or_else(|| bundle_for_identifier(bundle_id))
    else {
        return AppPresentation::default();
    };
    bundle_presentation(bundle)
}

/// Applications Launch Services offers for `file`, the default one first.
/// Identified by bundle identifier, launched from their bundle.
pub(crate) fn offered_apps(file: &Path) -> Vec<OfferedApp> {
    let workspace = NSWorkspace::sharedWorkspace();
    let url = NSURL::fileURLWithPath(&NSString::from_str(&file.to_string_lossy()));
    let default = workspace
        .URLForApplicationToOpenURL(&url)
        .and_then(|app| url_path(&app));
    let mut bundles: Vec<PathBuf> = default.iter().cloned().collect();
    if available!(macos = 12.0) {
        bundles.extend(
            workspace
                .URLsForApplicationsToOpenURL(&url)
                .iter()
                .filter_map(|app| url_path(&app)),
        );
    }

    bundles
        .into_iter()
        .filter_map(|bundle| {
            let id = bundle_identifier(&bundle)?;
            let presentation = bundle_presentation(bundle.clone());
            Some(OfferedApp {
                id,
                label: presentation
                    .label
                    .or_else(|| bundle_stem(&bundle))
                    .unwrap_or_default(),
                icon: presentation.icon,
                is_default: default.as_ref() == Some(&bundle),
                location: bundle,
            })
        })
        .collect()
}

fn bundle_presentation(bundle: PathBuf) -> AppPresentation {
    let mut cache = PRESENTATIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache
        .entry(bundle)
        .or_insert_with_key(|bundle| AppPresentation {
            label: display_name(bundle),
            icon: icon_data_url(bundle),
        })
        .clone()
}

fn url_path(url: &NSURL) -> Option<PathBuf> {
    url.path().map(|path| PathBuf::from(path.to_string()))
}

fn bundle_identifier(bundle: &Path) -> Option<String> {
    let url = NSURL::fileURLWithPath(&NSString::from_str(&bundle.to_string_lossy()));
    NSBundle::bundleWithURL(&url)?
        .bundleIdentifier()
        .map(|id| id.to_string())
        .filter(|id| !id.is_empty())
}

fn bundle_stem(bundle: &Path) -> Option<String> {
    bundle
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
}

fn bundle_for_identifier(bundle_id: &str) -> Option<PathBuf> {
    NSWorkspace::sharedWorkspace()
        .URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))
        .and_then(|url| url_path(&url))
}

fn display_name(bundle: &Path) -> Option<String> {
    let name = NSFileManager::defaultManager()
        .displayNameAtPath(&NSString::from_str(&bundle.to_string_lossy()))
        .to_string();
    let name = name.strip_suffix(".app").unwrap_or(&name).trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn icon_data_url(bundle: &Path) -> Option<String> {
    let image =
        NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(&bundle.to_string_lossy()));
    let mut rect = NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(ICON_PIXELS, ICON_PIXELS),
    );
    // SAFETY: `rect` is a valid, exclusively borrowed rect; no context or hints are passed.
    let cg_image = unsafe { image.CGImageForProposedRect_context_hints(&mut rect, None, None) }?;
    let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg_image);
    // SAFETY: an empty properties dictionary is valid for PNG encoding.
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(png.to_vec())
    ))
}
