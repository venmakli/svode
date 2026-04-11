'use client';

import { CaptionPlugin } from '@platejs/caption/react';
import {
  AudioPlugin,
  FilePlugin,
  ImagePlugin,
  MediaEmbedPlugin,
  PlaceholderPlugin,
  VideoPlugin,
} from '@platejs/media/react';
import { KEYS } from 'platejs';

import { AudioElement } from '@/components/ui/media-audio-node';
import { MediaEmbedElement } from '@/components/ui/media-embed-node';
import { FileElement } from '@/components/ui/media-file-node';
import { ImageElement } from '@/components/ui/media-image-node';
import { PlaceholderElement } from '@/components/ui/media-placeholder-node';
import { MediaPreviewDialog } from '@/components/ui/media-preview-dialog';
import { MediaUploadToast } from '@/components/ui/media-upload-toast';
import { VideoElement } from '@/components/ui/media-video-node';

export const MediaKit = [
  ImagePlugin.configure({
    options: { disableUploadInsert: true },
    render: { afterEditable: MediaPreviewDialog, node: ImageElement },
  }),
  MediaEmbedPlugin.withComponent(MediaEmbedElement),
  VideoPlugin.withComponent(VideoElement),
  AudioPlugin.withComponent(AudioElement),
  FilePlugin.withComponent(FileElement),
  PlaceholderPlugin.configure({
    options: {
      disableEmptyPlaceholder: true,
      // Override Plate's defaults. The defaults include a `text` category
      // with a 64KB limit that hits any `.txt` file routed through
      // `insert.media` and produces a confusing "too large than 64KB" toast
      // even from the Insert Image button. We drop `text` and `pdf`
      // categories so everything that is not image/video/audio falls through
      // to `blob` and becomes a generic file node.
      //
      // Size limits: capped at 128MB across the board because the current
      // upload path ships bytes through a JSON-serialized Tauri IPC
      // (`upload_asset` takes `Vec<u8>`), which produces ~5-8x peak memory
      // overhead in the WKWebView process during serialization. Larger
      // files are a real OOM risk for the webview process on macOS. To
      // lift these limits we need a path-based IPC that copies files
      // disk-to-disk in Rust without loading bytes into JS — tracked in
      // research/roadmap/TODO.md.
      uploadConfig: {
        // Plate's FileSize type only allows powers of 2 (1, 2, 4, 8, …, 1024).
        image: {
          maxFileCount: 10,
          maxFileSize: '64MB',
          mediaType: KEYS.img,
          minFileCount: 1,
        },
        video: {
          maxFileCount: 1,
          maxFileSize: '128MB',
          mediaType: KEYS.video,
          minFileCount: 1,
        },
        audio: {
          maxFileCount: 1,
          maxFileSize: '64MB',
          mediaType: KEYS.audio,
          minFileCount: 1,
        },
        blob: {
          maxFileCount: 1,
          maxFileSize: '128MB',
          mediaType: KEYS.file,
          minFileCount: 1,
        },
      },
    },
    render: { afterEditable: MediaUploadToast, node: PlaceholderElement },
  }),
  CaptionPlugin.configure({
    options: {
      query: {
        allow: [KEYS.img, KEYS.video, KEYS.audio, KEYS.file, KEYS.mediaEmbed],
      },
    },
  }),
];
