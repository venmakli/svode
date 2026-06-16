'use client';

import { LinkPlugin } from '@platejs/link/react';

import { DocLinkElement } from '@/features/editor';
import { DocLinkFloatingToolbar } from '@/features/editor';

export const LinkKit = [
  LinkPlugin.configure({
    render: {
      node: DocLinkElement,
      afterEditable: () => <DocLinkFloatingToolbar />,
    },
  }),
];
