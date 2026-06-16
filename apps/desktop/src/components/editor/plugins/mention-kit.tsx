'use client';

import { MentionInputPlugin, MentionPlugin } from '@platejs/mention/react';

import { MentionElement } from '@/components/ui/mention-node';
import { MentionInputElement } from '@/components/ui/mention-node';

export const MentionKit = [
  MentionPlugin.configure({
    options: {
      triggerPreviousCharPattern: /^$|^[\s"']$/,
    },
  }).withComponent(MentionElement),
  MentionInputPlugin.withComponent(MentionInputElement),
];
