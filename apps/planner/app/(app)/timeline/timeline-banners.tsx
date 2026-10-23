'use client';

import { Button, Link } from '@better-tracker/ui';
import { useId, useState } from 'react';

import type {
  TimelineBanner,
  TimelineSelection,
} from '../../../lib/adapters/timeline';
import css from './page.module.css';

/* The timeline's missing-input banners (architecture §8.4: no lead, no
   date, unplanned issues, blocked projects) as one compact block: a
   hairline frame with one 2px rule down its left edge, and a 1px ruled
   row per banner (mono key with its count, one sentence, a quiet Show /
   Hide) that expands to the list it counts. Each row carries its banner's
   status tone (data-tone, §8.2: every banner is a warning, amber), which
   colours its key; the block's rule is amber. One block instead
   of four 2px boxes keeps the emphasis to a single rule and lets the chart
   start higher. Rows open the lane or the milestone drawer through
   `hrefFor`, which keeps the current filters in the URL; issue keys open
   Linear in a new tab. Banners at zero are not rendered (the adapter
   leaves them out). */
export default function TimelineBanners({
  banners,
  hrefFor,
}: {
  banners: TimelineBanner[];
  hrefFor: (selection: TimelineSelection) => string;
}) {
  if (banners.length === 0) return null;
  return (
    <section className={css.banners} aria-label="Missing inputs">
      <ul className={css.bannerRows}>
        {banners.map((banner) => (
          <BannerRow key={banner.id} banner={banner} hrefFor={hrefFor} />
        ))}
      </ul>
    </section>
  );
}

function BannerRow({
  banner,
  hrefFor,
}: {
  banner: TimelineBanner;
  hrefFor: (selection: TimelineSelection) => string;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const noun = banner.items.length === 1 ? 'item' : 'items';
  return (
    <li
      className={css.banner}
      data-banner-id={banner.id}
      data-tone={banner.tone}
    >
      <div className={css.bannerHead}>
        <span className={css.bannerKey}>
          {banner.label} · {banner.count}
        </span>
        <p className={css.bannerText}>{banner.text}</p>
        <span className={css.bannerAction}>
          <Button
            size="sm"
            variant="quiet"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((was) => !was)}
          >
            {open ? 'Hide' : `Show ${banner.items.length} ${noun}`}
          </Button>
        </span>
      </div>
      <ul id={listId} className={css.bannerList} hidden={!open}>
        {banner.items.map((item) => (
          <li key={item.id} className={css.bannerItem}>
            <Link href={hrefFor(item.target)} className={css.bannerLink}>
              {item.label}
            </Link>
            {item.detail === undefined ? null : (
              <span className={css.bannerDetail}>{item.detail}</span>
            )}
            {item.links === undefined || item.links.length === 0 ? null : (
              <span className={css.bannerIssues}>
                {item.links.map((link) => (
                  <a
                    key={link.href}
                    className={css.issueKeyLink}
                    href={link.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label={`${link.label} in Linear (opens in a new tab)`}
                  >
                    {link.label}
                  </a>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}
