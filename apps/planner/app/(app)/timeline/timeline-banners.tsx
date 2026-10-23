'use client';

import { Button, Link } from '@better-tracker/ui';
import {
  CalendarX,
  ChevronDown,
  Inbox,
  type LucideIcon,
  OctagonPause,
  UserRoundX,
} from 'lucide-react';
import { useId, useState } from 'react';

import type {
  TimelineBanner,
  TimelineBannerId,
  TimelineSelection,
} from '../../../lib/adapters/timeline';
import css from './page.module.css';

/** The icon each banner leads with (drawing only; the lead-in says it). */
const BANNER_ICON: Record<TimelineBannerId, LucideIcon> = {
  no_lead: UserRoundX,
  no_date: CalendarX,
  unplanned: Inbox,
  blocked: OctagonPause,
};

/* The timeline's missing-input banners (architecture §8.4: no lead, no
   date, unplanned issues, blocked projects) as one Gr8r panel with a
   divider row per banner, never a stack of tinted boxes: an icon in the
   banner's hue (its status tone from the adapter, as data-tone; §8.2:
   every banner is a warning, amber, unplanned issues included since they
   are never allocated), the lead-in in the tone's ink, one sentence with
   the count, and a quiet Show / Hide that expands the list it counts.
   Every row shows on every width (on a narrow screen the sentence wraps
   under its lead-in and Show). Rows open the lane or the milestone drawer
   through `hrefFor`, which keeps the current filters in the URL; issue
   keys open Linear in a new tab. Banners at zero are not rendered (the
   adapter leaves them out). */
export default function TimelineBanners({
  banners,
  hrefFor,
}: {
  banners: TimelineBanner[];
  hrefFor: (selection: TimelineSelection) => string;
}) {
  if (banners.length === 0) return null;
  return (
    <section className={css.bannerPanel} aria-label="Missing inputs">
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
  const Icon = BANNER_ICON[banner.id];
  return (
    <li
      className={css.banner}
      data-banner-id={banner.id}
      data-tone={banner.tone}
    >
      <div className={css.bannerHead}>
        <Icon
          className={css.bannerIcon}
          size={14}
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className={css.bannerKey}>{banner.label}</span>
        <p className={css.bannerText}>{banner.text}</p>
        <span className={css.bannerAction}>
          <Button
            size="sm"
            variant="quiet"
            iconAfter={
              <ChevronDown
                size={14}
                strokeWidth={1.8}
                style={open ? { transform: 'rotate(180deg)' } : undefined}
              />
            }
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
            {item.action === undefined ? null : (
              <Link
                href={item.action.href}
                className={`accentLink ${css.bannerPlan}`}
              >
                {item.action.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}
