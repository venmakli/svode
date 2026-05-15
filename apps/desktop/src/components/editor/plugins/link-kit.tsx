'use client';

import { LinkPlugin } from '@platejs/link/react';

import { DocLinkElement } from '@/features/editor/doc-link-element';
import { DocLinkFloatingToolbar } from '@/features/editor/doc-link-toolbar';

export const LinkKit = [
  LinkPlugin.configure({
    render: {
      node: DocLinkElement,
      afterEditable: () => <DocLinkFloatingToolbar />,
    },
  }),
];
