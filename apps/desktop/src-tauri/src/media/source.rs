use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::AppError;
use crate::attachments::source::resolve_registered_owner;
use crate::files::tree::child_folder_names;
use crate::repo_path::{RootMode, normalize_repo_relative};

pub(crate) const FULL_RESPONSE_LIMIT: u64 = 64 * 1024 * 1024;
pub(crate) const RANGE_RESPONSE_LIMIT: u64 = 8 * 1024 * 1024;
const SVG_SOURCE_LIMIT: u64 = 4 * 1024 * 1024;
const HEADER_READ_LIMIT: u64 = 1024 * 1024;
const RASTER_SIDE_LIMIT: u32 = 16_384;
const RASTER_PIXEL_LIMIT: u64 = 40_000_000;
const GIF_CUMULATIVE_PIXEL_LIMIT: u64 = 256_000_000;
const GIT_LFS_POINTER_PREFIX: &[u8] = b"version https://git-lfs.github.com/spec/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MediaFormat {
    Png,
    Jpeg,
    Webp,
    Gif,
    Svg,
    Avif,
    Ico,
    Mp3,
    Wav,
    M4a,
    Aac,
    Flac,
    Ogg,
    Opus,
    Mp4,
    M4v,
    Mov,
    Webm,
    Mkv,
    Avi,
    Wmv,
    Mpg,
    Mpeg,
    ThreeGp,
    Wma,
    Aiff,
}

impl MediaFormat {
    fn from_path(path: &Path) -> Option<Self> {
        let extension = path.extension()?.to_str()?.to_ascii_lowercase();
        match extension.as_str() {
            "png" => Some(Self::Png),
            "jpg" | "jpeg" => Some(Self::Jpeg),
            "webp" => Some(Self::Webp),
            "gif" => Some(Self::Gif),
            "svg" => Some(Self::Svg),
            "avif" => Some(Self::Avif),
            "ico" => Some(Self::Ico),
            "mp3" => Some(Self::Mp3),
            "wav" => Some(Self::Wav),
            "m4a" => Some(Self::M4a),
            "aac" => Some(Self::Aac),
            "flac" => Some(Self::Flac),
            "ogg" => Some(Self::Ogg),
            "opus" => Some(Self::Opus),
            "mp4" => Some(Self::Mp4),
            "m4v" => Some(Self::M4v),
            "mov" => Some(Self::Mov),
            "webm" => Some(Self::Webm),
            "mkv" => Some(Self::Mkv),
            "avi" => Some(Self::Avi),
            "wmv" => Some(Self::Wmv),
            "mpg" => Some(Self::Mpg),
            "mpeg" => Some(Self::Mpeg),
            "3gp" => Some(Self::ThreeGp),
            "wma" => Some(Self::Wma),
            "aiff" => Some(Self::Aiff),
            _ => None,
        }
    }

    pub(crate) fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
            Self::Gif => "image/gif",
            Self::Svg => "image/svg+xml",
            Self::Avif => "image/avif",
            Self::Ico => "image/x-icon",
            Self::Mp3 => "audio/mpeg",
            Self::Wav => "audio/wav",
            Self::M4a => "audio/mp4",
            Self::Aac => "audio/aac",
            Self::Flac => "audio/flac",
            Self::Ogg => "audio/ogg",
            Self::Opus => "audio/ogg",
            Self::Mp4 => "video/mp4",
            Self::M4v => "video/mp4",
            Self::Mov => "video/quicktime",
            Self::Webm => "video/webm",
            Self::Mkv => "video/x-matroska",
            Self::Avi => "video/x-msvideo",
            Self::Wmv => "video/x-ms-wmv",
            Self::Mpg | Self::Mpeg => "video/mpeg",
            Self::ThreeGp => "video/3gpp",
            Self::Wma => "audio/x-ms-wma",
            Self::Aiff => "audio/aiff",
        }
    }

    pub(crate) fn is_baseline_image(self) -> bool {
        matches!(
            self,
            Self::Png | Self::Jpeg | Self::Webp | Self::Gif | Self::Svg
        )
    }

    fn encoded_limit(self) -> Option<u64> {
        match self {
            Self::Svg => Some(SVG_SOURCE_LIMIT),
            Self::Png | Self::Jpeg | Self::Webp | Self::Gif => Some(FULL_RESPONSE_LIMIT),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MediaFamily {
    Image,
    Audio,
    Video,
}

impl MediaFormat {
    fn family(self) -> MediaFamily {
        match self {
            Self::Png
            | Self::Jpeg
            | Self::Webp
            | Self::Gif
            | Self::Svg
            | Self::Avif
            | Self::Ico => MediaFamily::Image,
            Self::Mp3
            | Self::Wav
            | Self::M4a
            | Self::Aac
            | Self::Flac
            | Self::Ogg
            | Self::Opus
            | Self::Wma
            | Self::Aiff => MediaFamily::Audio,
            Self::Mp4
            | Self::M4v
            | Self::Mov
            | Self::Webm
            | Self::Mkv
            | Self::Avi
            | Self::Wmv
            | Self::Mpg
            | Self::Mpeg
            | Self::ThreeGp => MediaFamily::Video,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaSourceDescriptor {
    pub format: MediaFormat,
    pub family: MediaFamily,
    pub mime_type: &'static str,
    pub size_bytes: u64,
    pub generation: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub animated: bool,
    pub intrinsic_oversized: bool,
    pub inline_preview: bool,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum MediaSourceError {
    #[error("Media source is missing")]
    SourceMissing,
    #[error("Media source is not accessible or its local bytes are unavailable")]
    SourceUnavailable,
    #[error("This file is not a supported Media source")]
    UnsupportedFormat,
    #[error("Media source exceeds a preview resource limit")]
    ResourceLimit {
        limit_bytes: Option<u64>,
        actual_bytes: Option<u64>,
    },
    #[error("Media source is malformed")]
    Malformed,
    #[error("Media source changed while it was being opened")]
    SourceChanged,
    #[error("No application could open this Media")]
    ExternalOpenFailed,
}

impl Serialize for MediaSourceError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct StructuredError<'a> {
            kind: &'static str,
            message: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            limit_bytes: Option<u64>,
            #[serde(skip_serializing_if = "Option::is_none")]
            actual_bytes: Option<u64>,
        }

        let (kind, limit_bytes, actual_bytes) = match self {
            Self::SourceMissing => ("source_missing", None, None),
            Self::SourceUnavailable => ("source_unavailable", None, None),
            Self::UnsupportedFormat => ("unsupported_format", None, None),
            Self::ResourceLimit {
                limit_bytes,
                actual_bytes,
            } => ("resource_limit", *limit_bytes, *actual_bytes),
            Self::Malformed => ("malformed", None, None),
            Self::SourceChanged => ("source_changed", None, None),
            Self::ExternalOpenFailed => ("external_open_failed", None, None),
        };
        let message = self.to_string();
        StructuredError {
            kind,
            message: &message,
            limit_bytes,
            actual_bytes,
        }
        .serialize(serializer)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct MediaSourceTarget {
    pub project_path: PathBuf,
    pub space_id: Option<String>,
    pub target_path: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedMediaSource {
    pub target: MediaSourceTarget,
    pub descriptor: MediaSourceDescriptor,
}

pub(crate) fn inspect_media_source(
    project_path: &Path,
    space_id: Option<&str>,
    target_path: &str,
) -> Result<ResolvedMediaSource, MediaSourceError> {
    let (path, target, format, metadata) = resolve_media_path(project_path, space_id, target_path)?;
    if let Some(limit_bytes) = format.encoded_limit()
        && metadata.len() > limit_bytes
    {
        return Err(MediaSourceError::ResourceLimit {
            limit_bytes: Some(limit_bytes),
            actual_bytes: Some(metadata.len()),
        });
    }

    let generation = source_generation(format, &metadata)?;
    let mut descriptor = MediaSourceDescriptor {
        format,
        family: format.family(),
        mime_type: format.mime_type(),
        size_bytes: metadata.len(),
        generation,
        width: None,
        height: None,
        animated: false,
        intrinsic_oversized: false,
        inline_preview: format.is_baseline_image(),
    };

    let prefix = read_prefix(&path, metadata.len().min(HEADER_READ_LIMIT))?;
    if prefix.starts_with(GIT_LFS_POINTER_PREFIX) {
        return Err(MediaSourceError::SourceUnavailable);
    }
    if format.is_baseline_image() {
        let image = inspect_image(format, &path, &prefix)?;
        descriptor.width = image.width;
        descriptor.height = image.height;
        descriptor.animated = image.animated;
        descriptor.intrinsic_oversized = image.intrinsic_oversized;
    }
    confirm_generation(&path, &descriptor)?;

    Ok(ResolvedMediaSource { target, descriptor })
}

pub(crate) fn resolve_media_source_for_external(
    project_path: &Path,
    space_id: Option<&str>,
    target_path: &str,
) -> Result<PathBuf, MediaSourceError> {
    let (path, _, _, metadata) = resolve_media_path(project_path, space_id, target_path)?;
    let prefix = read_prefix(
        &path,
        metadata.len().min(GIT_LFS_POINTER_PREFIX.len() as u64),
    )?;
    if prefix.starts_with(GIT_LFS_POINTER_PREFIX) {
        return Err(MediaSourceError::SourceUnavailable);
    }
    Ok(path)
}

pub(crate) fn validate_media_source_generation(
    project_path: &Path,
    space_id: Option<&str>,
    target_path: &str,
    expected_generation: &str,
) -> Result<(), MediaSourceError> {
    let (path, _, format, metadata) = resolve_media_path(project_path, space_id, target_path)?;
    if source_generation(format, &metadata)? != expected_generation {
        return Err(MediaSourceError::SourceChanged);
    }
    let prefix = read_prefix(
        &path,
        metadata.len().min(GIT_LFS_POINTER_PREFIX.len() as u64),
    )?;
    if prefix.starts_with(GIT_LFS_POINTER_PREFIX) {
        return Err(MediaSourceError::SourceUnavailable);
    }
    Ok(())
}

pub(crate) fn resolve_capability_source(
    target: &MediaSourceTarget,
    expected: &MediaSourceDescriptor,
) -> Result<PathBuf, MediaSourceError> {
    let (path, _, format, metadata) = resolve_media_path(
        &target.project_path,
        target.space_id.as_deref(),
        &target.target_path,
    )?;
    if format != expected.format
        || metadata.len() != expected.size_bytes
        || source_generation(format, &metadata)? != expected.generation
    {
        return Err(MediaSourceError::SourceChanged);
    }
    Ok(path)
}

fn resolve_media_path(
    project_path: &Path,
    space_id: Option<&str>,
    target_path: &str,
) -> Result<(PathBuf, MediaSourceTarget, MediaFormat, fs::Metadata), MediaSourceError> {
    let owner = resolve_registered_owner(project_path, space_id).map_err(map_source_error)?;
    let space_root = fs::canonicalize(&owner.space_path).map_err(map_io_error)?;
    let normalized = normalize_repo_relative(target_path, RootMode::Reject)
        .map_err(|_| MediaSourceError::SourceUnavailable)?;
    reject_registered_space_boundary(&space_root, &normalized)?;
    reject_symlink_components(&space_root, Path::new(&normalized))?;

    let candidate = space_root.join(&normalized);
    let metadata = fs::symlink_metadata(&candidate).map_err(map_io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(MediaSourceError::SourceUnavailable);
    }
    let canonical = fs::canonicalize(&candidate).map_err(map_io_error)?;
    if !canonical.starts_with(&space_root) {
        return Err(MediaSourceError::SourceUnavailable);
    }
    let format = MediaFormat::from_path(&canonical).ok_or(MediaSourceError::UnsupportedFormat)?;
    Ok((
        canonical,
        MediaSourceTarget {
            project_path: owner.project_path,
            space_id: owner.space_id,
            target_path: normalized,
        },
        format,
        metadata,
    ))
}

fn confirm_generation(
    path: &Path,
    expected: &MediaSourceDescriptor,
) -> Result<(), MediaSourceError> {
    let metadata = fs::symlink_metadata(path).map_err(map_io_error)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() != expected.size_bytes
        || source_generation(expected.format, &metadata)? != expected.generation
    {
        return Err(MediaSourceError::SourceChanged);
    }
    Ok(())
}

fn source_generation(
    format: MediaFormat,
    metadata: &fs::Metadata,
) -> Result<String, MediaSourceError> {
    let modified = metadata
        .modified()
        .map_err(map_io_error)?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| MediaSourceError::SourceUnavailable)?;
    let mut hasher = Sha256::new();
    hasher.update(format!("{format:?}").as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified.as_secs().to_le_bytes());
    hasher.update(modified.subsec_nanos().to_le_bytes());
    let digest = hasher.finalize();
    Ok(digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn read_prefix(path: &Path, limit: u64) -> Result<Vec<u8>, MediaSourceError> {
    let mut bytes = Vec::with_capacity(limit as usize);
    File::open(path)
        .map_err(map_io_error)?
        .take(limit)
        .read_to_end(&mut bytes)
        .map_err(map_io_error)?;
    Ok(bytes)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ImageMetadata {
    width: Option<u32>,
    height: Option<u32>,
    animated: bool,
    intrinsic_oversized: bool,
}

fn inspect_image(
    format: MediaFormat,
    path: &Path,
    prefix: &[u8],
) -> Result<ImageMetadata, MediaSourceError> {
    match format {
        MediaFormat::Png => raster_metadata(parse_png_dimensions(prefix)?),
        MediaFormat::Jpeg => raster_metadata(parse_jpeg_dimensions(prefix)?),
        MediaFormat::Webp => raster_metadata(parse_webp_dimensions(prefix)?),
        MediaFormat::Gif => inspect_gif(path),
        MediaFormat::Svg => inspect_svg(prefix),
        _ => Err(MediaSourceError::UnsupportedFormat),
    }
}

fn raster_metadata((width, height): (u32, u32)) -> Result<ImageMetadata, MediaSourceError> {
    validate_raster_dimensions(width, height)?;
    Ok(ImageMetadata {
        width: Some(width),
        height: Some(height),
        animated: false,
        intrinsic_oversized: false,
    })
}

fn validate_raster_dimensions(width: u32, height: u32) -> Result<(), MediaSourceError> {
    if width == 0
        || height == 0
        || width > RASTER_SIDE_LIMIT
        || height > RASTER_SIDE_LIMIT
        || u64::from(width) * u64::from(height) > RASTER_PIXEL_LIMIT
    {
        return Err(MediaSourceError::ResourceLimit {
            limit_bytes: None,
            actual_bytes: None,
        });
    }
    Ok(())
}

fn parse_png_dimensions(bytes: &[u8]) -> Result<(u32, u32), MediaSourceError> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return Err(MediaSourceError::Malformed);
    }
    Ok((
        u32::from_be_bytes(bytes[16..20].try_into().expect("PNG width")),
        u32::from_be_bytes(bytes[20..24].try_into().expect("PNG height")),
    ))
}

fn parse_jpeg_dimensions(bytes: &[u8]) -> Result<(u32, u32), MediaSourceError> {
    if bytes.len() < 4 || bytes[..2] != [0xff, 0xd8] {
        return Err(MediaSourceError::Malformed);
    }
    let mut offset = 2;
    while offset < bytes.len() {
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        if offset >= bytes.len() {
            break;
        }
        let marker = bytes[offset];
        offset += 1;
        if marker == 0xd9 || marker == 0xda {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
            continue;
        }
        if offset + 2 > bytes.len() {
            break;
        }
        let segment_length = usize::from(u16::from_be_bytes([bytes[offset], bytes[offset + 1]]));
        if segment_length < 2 || offset + segment_length > bytes.len() {
            break;
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) {
            if segment_length < 7 {
                break;
            }
            let height = u32::from(u16::from_be_bytes([bytes[offset + 3], bytes[offset + 4]]));
            let width = u32::from(u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]));
            return Ok((width, height));
        }
        offset += segment_length;
    }
    Err(MediaSourceError::Malformed)
}

fn parse_webp_dimensions(bytes: &[u8]) -> Result<(u32, u32), MediaSourceError> {
    if bytes.len() < 21 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err(MediaSourceError::Malformed);
    }
    let mut offset = 12;
    while offset + 8 <= bytes.len() {
        let chunk = &bytes[offset..offset + 4];
        let length = u32::from_le_bytes(
            bytes[offset + 4..offset + 8]
                .try_into()
                .expect("WebP chunk length"),
        ) as usize;
        let data = offset + 8;
        if data + length > bytes.len() {
            return Err(MediaSourceError::Malformed);
        }
        if chunk == b"VP8X" && length >= 10 {
            let width = 1 + read_u24_le(&bytes[data + 4..data + 7]);
            let height = 1 + read_u24_le(&bytes[data + 7..data + 10]);
            return Ok((width, height));
        }
        if chunk == b"VP8 " && length >= 10 && bytes[data + 3..data + 6] == [0x9d, 0x01, 0x2a] {
            let width = u32::from(u16::from_le_bytes([bytes[data + 6], bytes[data + 7]]) & 0x3fff);
            let height = u32::from(u16::from_le_bytes([bytes[data + 8], bytes[data + 9]]) & 0x3fff);
            return Ok((width, height));
        }
        if chunk == b"VP8L" && length >= 5 && bytes[data] == 0x2f {
            let bits = u32::from_le_bytes([
                bytes[data + 1],
                bytes[data + 2],
                bytes[data + 3],
                bytes[data + 4],
            ]);
            let width = (bits & 0x3fff) + 1;
            let height = ((bits >> 14) & 0x3fff) + 1;
            return Ok((width, height));
        }
        offset = data + length + (length % 2);
    }
    Err(MediaSourceError::Malformed)
}

fn read_u24_le(bytes: &[u8]) -> u32 {
    u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) | (u32::from(bytes[2]) << 16)
}

fn inspect_gif(path: &Path) -> Result<ImageMetadata, MediaSourceError> {
    let bytes = fs::read(path).map_err(map_io_error)?;
    if bytes.len() < 14 || !matches!(&bytes[..6], b"GIF87a" | b"GIF89a") {
        return Err(MediaSourceError::Malformed);
    }
    let width = u32::from(u16::from_le_bytes([bytes[6], bytes[7]]));
    let height = u32::from(u16::from_le_bytes([bytes[8], bytes[9]]));
    validate_raster_dimensions(width, height)?;
    let packed = bytes[10];
    let mut offset = 13;
    if packed & 0x80 != 0 {
        offset += 3 * (1usize << (usize::from(packed & 0x07) + 1));
    }
    let mut frames = 0u64;
    loop {
        let marker = *bytes.get(offset).ok_or(MediaSourceError::Malformed)?;
        offset += 1;
        match marker {
            0x3b => break,
            0x21 => {
                offset += 1;
                skip_gif_sub_blocks(&bytes, &mut offset)?;
            }
            0x2c => {
                let descriptor = bytes
                    .get(offset..offset + 9)
                    .ok_or(MediaSourceError::Malformed)?;
                let frame_width = u32::from(u16::from_le_bytes([descriptor[4], descriptor[5]]));
                let frame_height = u32::from(u16::from_le_bytes([descriptor[6], descriptor[7]]));
                if frame_width == 0 || frame_height == 0 {
                    return Err(MediaSourceError::Malformed);
                }
                frames = frames
                    .checked_add(1)
                    .ok_or(MediaSourceError::ResourceLimit {
                        limit_bytes: None,
                        actual_bytes: None,
                    })?;
                if frames
                    .checked_mul(u64::from(width) * u64::from(height))
                    .is_none_or(|pixels| pixels > GIF_CUMULATIVE_PIXEL_LIMIT)
                {
                    return Err(MediaSourceError::ResourceLimit {
                        limit_bytes: None,
                        actual_bytes: None,
                    });
                }
                offset += 9;
                if descriptor[8] & 0x80 != 0 {
                    offset += 3 * (1usize << (usize::from(descriptor[8] & 0x07) + 1));
                }
                offset += 1;
                skip_gif_sub_blocks(&bytes, &mut offset)?;
            }
            _ => return Err(MediaSourceError::Malformed),
        }
    }
    if frames == 0 {
        return Err(MediaSourceError::Malformed);
    }
    Ok(ImageMetadata {
        width: Some(width),
        height: Some(height),
        animated: frames > 1,
        intrinsic_oversized: false,
    })
}

fn skip_gif_sub_blocks(bytes: &[u8], offset: &mut usize) -> Result<(), MediaSourceError> {
    loop {
        let size = usize::from(*bytes.get(*offset).ok_or(MediaSourceError::Malformed)?);
        *offset += 1;
        if size == 0 {
            return Ok(());
        }
        *offset = offset
            .checked_add(size)
            .filter(|next| *next <= bytes.len())
            .ok_or(MediaSourceError::Malformed)?;
    }
}

fn inspect_svg(bytes: &[u8]) -> Result<ImageMetadata, MediaSourceError> {
    let text = std::str::from_utf8(bytes).map_err(|_| MediaSourceError::Malformed)?;
    let root_start = text
        .match_indices("<svg")
        .find_map(|(offset, _)| {
            text.as_bytes()
                .get(offset + 4)
                .is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'>')
                .then_some(offset)
        })
        .ok_or(MediaSourceError::Malformed)?;
    let root_end = text[root_start..]
        .find('>')
        .map(|offset| root_start + offset)
        .ok_or(MediaSourceError::Malformed)?;
    let root = &text[root_start..=root_end];
    let width = svg_length(svg_attribute(root, "width"));
    let height = svg_length(svg_attribute(root, "height"));
    let view_box = svg_attribute(root, "viewBox")
        .or_else(|| svg_attribute(root, "viewbox"))
        .and_then(parse_svg_view_box);
    let (width, height) = match (width, height, view_box) {
        (Some(width), Some(height), _) => (Some(width), Some(height)),
        (_, _, Some((width, height))) => (Some(width), Some(height)),
        _ => (None, None),
    };
    let intrinsic_oversized = width.zip(height).is_some_and(|(width, height)| {
        width > RASTER_SIDE_LIMIT
            || height > RASTER_SIDE_LIMIT
            || u64::from(width) * u64::from(height) > RASTER_PIXEL_LIMIT
    });
    Ok(ImageMetadata {
        width,
        height,
        animated: false,
        intrinsic_oversized,
    })
}

fn svg_attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let bytes = tag.as_bytes();
    let name_bytes = name.as_bytes();
    let mut offset = 0;
    while offset + name_bytes.len() <= bytes.len() {
        let relative = tag[offset..].find(name)?;
        let start = offset + relative;
        let end = start + name_bytes.len();
        let boundary_before = start == 0 || bytes[start - 1].is_ascii_whitespace();
        let boundary_after =
            bytes.get(end).is_some_and(u8::is_ascii_whitespace) || bytes.get(end) == Some(&b'=');
        if !boundary_before || !boundary_after {
            offset = end;
            continue;
        }
        let mut cursor = end;
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b'=') {
            offset = end;
            continue;
        }
        cursor += 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        let quote = *bytes.get(cursor)?;
        if quote != b'\'' && quote != b'"' {
            return None;
        }
        cursor += 1;
        let value_start = cursor;
        while bytes.get(cursor).is_some_and(|byte| *byte != quote) {
            cursor += 1;
        }
        return tag.get(value_start..cursor);
    }
    None
}

fn svg_length(value: Option<&str>) -> Option<u32> {
    let value = value?.trim();
    let numeric = value.strip_suffix("px").unwrap_or(value).trim();
    if numeric.ends_with('%') || numeric.is_empty() {
        return None;
    }
    let value = numeric.parse::<f64>().ok()?;
    (value.is_finite() && value > 0.0 && value <= f64::from(u32::MAX))
        .then_some(value.round() as u32)
}

fn parse_svg_view_box(value: &str) -> Option<(u32, u32)> {
    let values = value
        .split(|character: char| character.is_ascii_whitespace() || character == ',')
        .filter(|part| !part.is_empty())
        .map(str::parse::<f64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if values.len() != 4
        || !values.iter().all(|value| value.is_finite())
        || values[2] <= 0.0
        || values[3] <= 0.0
        || values[2] > f64::from(u32::MAX)
        || values[3] > f64::from(u32::MAX)
    {
        return None;
    }
    Some((values[2].round() as u32, values[3].round() as u32))
}

fn reject_registered_space_boundary(
    space_path: &Path,
    normalized: &str,
) -> Result<(), MediaSourceError> {
    let first = Path::new(normalized)
        .components()
        .next()
        .map(|component| component.as_os_str().to_string_lossy().to_string());
    if first
        .as_ref()
        .is_some_and(|component| child_folder_names(space_path).contains(component))
    {
        return Err(MediaSourceError::SourceUnavailable);
    }
    Ok(())
}

fn reject_symlink_components(root: &Path, relative: &Path) -> Result<(), MediaSourceError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current).map_err(map_io_error)?;
        if metadata.file_type().is_symlink() {
            return Err(MediaSourceError::SourceUnavailable);
        }
    }
    Ok(())
}

fn map_source_error(error: AppError) -> MediaSourceError {
    match error {
        AppError::FileNotFound(_) => MediaSourceError::SourceMissing,
        AppError::Io(error) => map_io_error(error),
        _ => MediaSourceError::SourceUnavailable,
    }
}

fn map_io_error(error: std::io::Error) -> MediaSourceError {
    if error.kind() == std::io::ErrorKind::NotFound {
        MediaSourceError::SourceMissing
    } else {
        MediaSourceError::SourceUnavailable
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::config::write_space_config;
    use crate::space::types::SpaceConfig;

    fn write_project(path: &Path) {
        fs::create_dir_all(path).unwrap();
        write_space_config(
            path,
            &SpaceConfig {
                name: "Project".into(),
                description: String::new(),
                icon: "folder".into(),
                spaces: None,
                agent: None,
                defaults: None,
                git: None,
                assets: None,
                tree: None,
            },
        )
        .unwrap();
    }

    fn minimal_gif_with_size(width: u16, height: u16, frames: usize) -> Vec<u8> {
        let mut bytes = b"GIF89a".to_vec();
        bytes.extend_from_slice(&width.to_le_bytes());
        bytes.extend_from_slice(&height.to_le_bytes());
        bytes.extend_from_slice(b"\x00\x00\x00");
        for _ in 0..frames {
            bytes
                .extend_from_slice(b"\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00");
        }
        bytes.push(0x3b);
        bytes
    }

    fn minimal_gif(frames: usize) -> Vec<u8> {
        minimal_gif_with_size(1, 1, frames)
    }

    #[test]
    fn inspects_baseline_image_headers_and_generation() {
        let temp = tempfile::tempdir().unwrap();
        write_project(temp.path());
        let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        png.extend_from_slice(&320u32.to_be_bytes());
        png.extend_from_slice(&200u32.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        fs::write(temp.path().join("photo.png"), png).unwrap();

        let resolved = inspect_media_source(temp.path(), None, "photo.png").unwrap();
        assert_eq!(resolved.descriptor.format, MediaFormat::Png);
        assert_eq!(resolved.descriptor.width, Some(320));
        assert_eq!(resolved.descriptor.height, Some(200));
        assert!(resolved.descriptor.inline_preview);
        assert_eq!(
            resolve_capability_source(&resolved.target, &resolved.descriptor).unwrap(),
            fs::canonicalize(temp.path().join("photo.png")).unwrap()
        );

        fs::write(temp.path().join("photo.png"), b"changed").unwrap();
        assert!(matches!(
            validate_media_source_generation(
                temp.path(),
                None,
                "photo.png",
                &resolved.descriptor.generation
            ),
            Err(MediaSourceError::SourceChanged)
        ));
    }

    #[test]
    fn rejects_traversal_symlinks_and_unresolved_lfs_bytes() {
        let temp = tempfile::tempdir().unwrap();
        write_project(temp.path());
        fs::write(
            temp.path().join("pointer.png"),
            b"version https://git-lfs.github.com/spec/v1\noid sha256:fixture\nsize 100\n",
        )
        .unwrap();
        assert!(matches!(
            inspect_media_source(temp.path(), None, "../outside.png"),
            Err(MediaSourceError::SourceUnavailable)
        ));
        assert!(matches!(
            inspect_media_source(temp.path(), None, "pointer.png"),
            Err(MediaSourceError::SourceUnavailable)
        ));

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = tempfile::tempdir().unwrap();
            fs::write(outside.path().join("photo.png"), b"not an image").unwrap();
            symlink(outside.path(), temp.path().join("linked")).unwrap();
            assert!(matches!(
                inspect_media_source(temp.path(), None, "linked/photo.png"),
                Err(MediaSourceError::SourceUnavailable)
            ));
        }
    }

    #[test]
    fn gif_animation_is_detected_before_browser_decode() {
        let temp = tempfile::tempdir().unwrap();
        write_project(temp.path());
        fs::write(temp.path().join("motion.gif"), minimal_gif(2)).unwrap();
        let resolved = inspect_media_source(temp.path(), None, "motion.gif").unwrap();
        assert_eq!(resolved.descriptor.width, Some(1));
        assert_eq!(resolved.descriptor.height, Some(1));
        assert!(resolved.descriptor.animated);
    }

    #[test]
    fn svg_uses_intrinsic_or_viewbox_dimensions_without_parsing_markup_into_dom() {
        let direct =
            inspect_svg(br#"<svg width="640" height="480"><script>alert(1)</script></svg>"#)
                .unwrap();
        assert_eq!((direct.width, direct.height), (Some(640), Some(480)));

        let view_box = inspect_svg(br#"<svg viewBox="0 0 1200 800"></svg>"#).unwrap();
        assert_eq!((view_box.width, view_box.height), (Some(1200), Some(800)));
    }

    #[test]
    fn raster_dimensions_and_gif_cumulative_surface_are_bounded() {
        assert!(matches!(
            validate_raster_dimensions(20_000, 10),
            Err(MediaSourceError::ResourceLimit { .. })
        ));
        assert!(matches!(
            validate_raster_dimensions(10_000, 10_000),
            Err(MediaSourceError::ResourceLimit { .. })
        ));

        let temp = tempfile::tempdir().unwrap();
        write_project(temp.path());
        fs::write(
            temp.path().join("too-many-frames.gif"),
            minimal_gif_with_size(5_000, 5_000, 11),
        )
        .unwrap();
        assert!(matches!(
            inspect_media_source(temp.path(), None, "too-many-frames.gif"),
            Err(MediaSourceError::ResourceLimit { .. })
        ));
    }
}
