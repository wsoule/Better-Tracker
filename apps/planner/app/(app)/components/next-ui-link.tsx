'use client';

import type { UiLinkProps } from '@better-tracker/ui';
import NextLink from 'next/link';

/**
 * The host link the ui package renders through (UiLinkProvider): next/link
 * for pages, so navigation stays client-side. Links into /api/ (the OAuth
 * start, for one) stay plain anchors: next/link would prefetch them, and
 * prefetching GET /api/auth/linear would start an OAuth flow on its own.
 */
export default function NextUiLink({ href, children, ...rest }: UiLinkProps) {
  if (href.startsWith('/api/')) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <NextLink href={href} {...rest}>
      {children}
    </NextLink>
  );
}
