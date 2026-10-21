'use client';

import { Button, Link, Notice } from '@better-tracker/ui';
import { useId, useState } from 'react';

import type {
  TimelineBanner,
  TimelineSelection,
} from '../../../lib/adapters/timeline';
import css from './page.module.css';

/* The timeline's missing-input banners (architecture §8.4: no lead, no
   date, unplanned issues, blocked projects), each a Notice with its count
   that expands to the list it counts. Rows open the lane or the milestone
   drawer through `hrefFor`, which keeps the current filters in the URL;
   issue keys open Linear in a new tab. Banners at zero are not rendered
   (the adapter leaves them out). */
export default function TimelineBanners({
  banners,
  hrefFor,
}: {
  banners: TimelineBanner[];
  hrefFor: (selection: TimelineSelection) => string;
}) {
  return (
    <>
      {banners.map((banner) => (
        <BannerRow key={banner.id} banner={banner} hrefFor={hrefFor} />
      ))}
    </>
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
    <Notice
      label={`${banner.label} · ${banner.count}`}
      action={
        <Button
          size="sm"
          variant="quiet"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((was) => !was)}
        >
          {open ? 'Hide' : `Show ${banner.items.length} ${noun}`}
        </Button>
      }
    >
      <p>{banner.text}</p>
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
    </Notice>
  );
}
