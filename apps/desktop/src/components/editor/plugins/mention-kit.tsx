'use client';

import { MentionInputPlugin, MentionPlugin } from '@platejs/mention/react';

import { MentionElement } from '@/components/ui/mention-node';
import { DocLinkInputElement } from '@/features/editor';

export const MentionKit = [
  MentionPlugin.configure({
    options: {
      triggerPreviousCharPattern: /^$|^[\s"']$/,
    },
  }).withComponent(MentionElement),
  MentionInputPlugin.withComponent(DocLinkInputElement),
];
