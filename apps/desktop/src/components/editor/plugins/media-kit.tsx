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
      // Managed imports copy native file paths disk-to-disk in Rust, so the
      // editor can admit large files without serializing their bytes through
      // the WebView. Plate's typed size grammar currently tops out at 1GB.
      uploadConfig: {
        // Plate's FileSize type only allows powers of 2 (1, 2, 4, 8, …, 1024).
        image: {
          maxFileCount: 10,
          maxFileSize: '1GB',
          mediaType: KEYS.img,
          minFileCount: 1,
        },
        video: {
          maxFileCount: 1,
          maxFileSize: '1GB',
          mediaType: KEYS.video,
          minFileCount: 1,
        },
        audio: {
          maxFileCount: 1,
          maxFileSize: '1GB',
          mediaType: KEYS.audio,
          minFileCount: 1,
        },
        blob: {
          maxFileCount: 1,
          maxFileSize: '1GB',
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
