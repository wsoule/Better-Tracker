'use client';

import { Button, Link } from '@better-tracker/ui';
import {
  CalendarX,
  ChevronDown,
  CircleAlert,
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
   banner's hue (warning for a missing input or a blocked project, info for
   unplanned issues, from the adapter, as data-tone), the lead-in in the
   tone's ink, one sentence with the count, and a quiet Show / Hide that
   expands the list it counts. On a phone (≤ 640px) the panel folds into
   one row ("4 missing inputs", the lead-ins, Show) so the chart's cards
   start on the first screen. Rows open the lane or the milestone drawer
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
  const [phoneOpen, setPhoneOpen] = useState(false);
  const rowsId = useId();
  if (banners.length === 0) return null;
  // The phone row takes the loudest tone among the banners.
  const tone = banners.some((banner) => banner.tone === 'warning')
    ? 'warning'
    : (banners[0]?.tone ?? 'warning');
  return (
    <section
      className={css.bannerPanel}
      aria-label="Missing inputs"
      data-collapsed={phoneOpen ? undefined : 'true'}
    >
      {/* Phone only (CSS): the folded panel's one row. */}
      <div className={css.bannerSummary} data-tone={tone}>
        <CircleAlert
          className={css.bannerIcon}
          size={15}
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className={css.bannerKey}>
          {banners.length === 1
            ? '1 missing input'
            : `${banners.length} missing inputs`}
        </span>
        <span className={css.bannerSummaryText}>
          {banners.map((banner) => banner.label).join(' · ')}
        </span>
        <span className={css.bannerAction}>
          <Button
            size="sm"
            variant="quiet"
            iconAfter={
              <ChevronDown
                size={14}
                strokeWidth={1.8}
                style={phoneOpen ? { transform: 'rotate(180deg)' } : undefined}
              />
            }
            aria-expanded={phoneOpen}
            aria-controls={rowsId}
            onClick={() => setPhoneOpen((was) => !was)}
          >
            {phoneOpen ? 'Hide' : 'Show'}
          </Button>
        </span>
      </div>
      <ul id={rowsId} className={css.bannerRows}>
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
          size={15}
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
          </li>
        ))}
      </ul>
    </li>
  );
}
