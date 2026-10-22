// Turns one person's daily digest into a Slack message: Block Kit blocks for
// the rich view plus a plain top-level `text` used for notifications and as
// the accessible fallback. Slack's hard limits (docs/architecture.md §6) are
// enforced here so a big digest is truncated visibly instead of rejected.

import type { Digest, DigestIssue, DigestItem } from '@better-tracker/core';

import type { DeliveryContext } from './types';

/** A Block Kit plain_text object (shown literally, no markup). */
export interface SlackPlainText {
  type: 'plain_text';
  text: string;
}

/** A Block Kit mrkdwn object (Slack's markdown dialect). */
export interface SlackMrkdwn {
  type: 'mrkdwn';
  text: string;
}

export interface SlackHeaderBlock {
  type: 'header';
  text: SlackPlainText;
}

export interface SlackSectionBlock {
  type: 'section';
  text: SlackMrkdwn;
}

export interface SlackContextBlock {
  type: 'context';
  elements: (SlackMrkdwn | SlackPlainText)[];
}

export interface SlackDividerBlock {
  type: 'divider';
}

/** The subset of Block Kit blocks a digest uses. */
export type SlackBlock =
  | SlackHeaderBlock
  | SlackSectionBlock
  | SlackContextBlock
  | SlackDividerBlock;

export interface RenderedDigest {
  /** Plain summary for notifications/fallback (≤ 4000 chars, mrkdwn-escaped). */
  text: string;
  blocks: SlackBlock[];
}

/** Slack's documented limits for chat.postMessage. */
export const SLACK_LIMITS: {
  readonly maxBlocks: number;
  readonly headerText: number;
  readonly sectionText: number;
  readonly messageText: number;
} = {
  maxBlocks: 50,
  headerText: 150,
  sectionText: 3000,
  messageText: 4000,
};

const ELLIPSIS = '…';
/** Longest escaped title label inside a section (keeps room for lines). */
const LABEL_MAX = 300;
/** Longest escaped title label in the compact top-level text. */
const TEXT_LABEL_MAX = 150;
/** Longest escaped bullet line inside a section. */
const LINE_MAX = 500;
/** Longer URLs are dropped from links rather than risk a block's text limit. */
const URL_MAX = 1000;
/** Longest escaped due-date text ("Oct 23, 2026" is 12; malformed input is cut). */
const DATE_MAX = 32;
/** Blocks that are always present: the header and the divider below it. */
const FIXED_BLOCKS = 2;
/** Most open issues one section names before "…and N more open issues". */
const ISSUES_MAX = 10;
/** Longest escaped issue title inside an issue bullet. */
const ISSUE_TITLE_MAX = 120;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Renders a digest as `{ text, blocks }` for chat.postMessage. Pure and
 * deterministic: the same digest and context always give the same output.
 * Items keep `digest.items` order; anything that does not fit is counted in a
 * final "…and N more" context block, never dropped silently.
 */
export function renderDigest(
  digest: Digest,
  context: DeliveryContext
): RenderedDigest {
  const items = digest.items;
  const headerText = renderHeaderText(context.appName, items.length);
  const timelineUrl = `${trimTrailingSlashes(context.appUrl)}/timeline`;

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: headerText } },
    { type: 'divider' },
  ];

  // Everything fits when header + divider + one section per item stays within
  // the block limit; otherwise one slot goes to the overflow context block.
  const fitsAll = FIXED_BLOCKS + items.length <= SLACK_LIMITS.maxBlocks;
  const shown = fitsAll
    ? items.length
    : SLACK_LIMITS.maxBlocks - FIXED_BLOCKS - 1;

  for (let i = 0; i < shown; i++) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: renderSectionText(items[i]) },
    });
  }

  const hidden = items.length - shown;
  if (hidden > 0) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${ELLIPSIS}and ${hidden} more — open the timeline: ${mrkdwnLink(timelineUrl, 'Timeline')}`,
        },
      ],
    });
  }

  return { text: renderSummaryText(headerText, items), blocks };
}

/**
 * The kind line for one item, e.g. "Overdue by 3 days" or
 * "Due in 2 days — at risk". Exported so other surfaces can reuse the copy.
 */
export function describeItemKind(item: DigestItem): string {
  const { kind, daysLeft } = item.notice;
  switch (kind) {
    case 'overdue':
      return daysLeft !== null && daysLeft < 0
        ? `Overdue by ${pluralize(-daysLeft, 'day')}`
        : 'Overdue';
    case 'at_risk':
      return `${describeDue(daysLeft)} — at risk`;
    case 'invalid_due_soon':
      return `${describeDue(daysLeft)} — fails the milestone rubric`;
    case 'allocation_blocked':
      return 'Allocation stopped';
  }
}

/**
 * Escapes Slack's mrkdwn control characters. Only &, < and > are special;
 * entity-encoding anything else would show up literally in Slack.
 */
export function escapeMrkdwn(raw: string): string {
  return raw.replace(/[&<>]/g, escapeChar);
}

// Maps one control character to its entity; other characters pass through.
function escapeChar(ch: string): string {
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  return ch;
}

/**
 * Escapes `raw` for mrkdwn and cuts it so the escaped result is at most
 * `maxLength` UTF-16 units, ending in "…" when cut. Escaping happens per code
 * point, so a cut never lands inside an entity like `&amp;` or splits a
 * surrogate pair. UTF-16 length is never below Slack's character count, so
 * the limit holds however Slack counts.
 */
export function escapeAndTruncate(raw: string, maxLength: number): string {
  const escaped = escapeMrkdwn(raw);
  if (escaped.length <= maxLength) return escaped;
  const budget = maxLength - ELLIPSIS.length;
  let out = '';
  for (const ch of raw) {
    const piece = escapeChar(ch);
    if (out.length + piece.length > budget) break;
    out += piece;
  }
  return out + ELLIPSIS;
}

// Truncates text that is shown literally (plain_text), by code point.
function truncatePlain(raw: string, maxLength: number): string {
  if (raw.length <= maxLength) return raw;
  const budget = maxLength - ELLIPSIS.length;
  let out = '';
  for (const ch of raw) {
    if (out.length + ch.length > budget) break;
    out += ch;
  }
  return out + ELLIPSIS;
}

// Newlines inside a name or line would break the one-line-per-fact layout.
function singleLine(raw: string): string {
  return raw.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

// Link labels cannot contain `|` (ends the URL part) or `>` (ends the link).
function stripLinkLabel(raw: string): string {
  return raw.replace(/[|>]/g, '');
}

/**
 * Formats a URL for `<url|label>`: `&` is entity-encoded like any mrkdwn
 * text (Slack decodes it), while `<`, `>`, `|` and whitespace would end the
 * link early, so they are percent-encoded instead.
 */
function escapeLinkUrl(url: string): string {
  return url
    .trim()
    .replace(/[<>|\s]/g, (ch) => encodeURIComponent(ch))
    .replace(/&/g, '&amp;');
}

/**
 * `<url|label>` with the label stripped, escaped and capped at LABEL_MAX.
 * An empty URL, or one longer than URL_MAX once escaped, leaves just the
 * label, so no URL can push a block past Slack's text limits.
 */
function mrkdwnLink(url: string, label: string): string {
  const href = escapeLinkUrl(url);
  const text = escapeAndTruncate(stripLinkLabel(label), LABEL_MAX);
  return href === '' || href.length > URL_MAX ? text : `<${href}|${text}>`;
}

function trimTrailingSlashes(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// "Due today", "Due in 1 day", "Due in 4 days"; negative counts read as
// overdue so a stale notice never claims a past date is upcoming.
function describeDue(daysLeft: number | null): string {
  if (daysLeft === null) return 'Due soon';
  if (daysLeft < 0) return `Overdue by ${pluralize(-daysLeft, 'day')}`;
  if (daysLeft === 0) return 'Due today';
  return `Due in ${pluralize(daysLeft, 'day')}`;
}

/**
 * "Oct 23, 2026" for a `YYYY-MM-DD` date, computed by hand so the output
 * never depends on the host's locale or timezone. Anything malformed is
 * returned as-is (and escaped by the caller).
 */
function formatDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return date;
  const month = MONTHS[Number(match[2]) - 1];
  if (month === undefined) return date;
  return `${month} ${Number(match[3])}, ${match[1]}`;
}

// "Project › Milestone", or just the project for project-level notices.
function itemLabel(item: DigestItem): string {
  const project = singleLine(item.projectName);
  const milestone =
    item.milestoneName === null ? '' : singleLine(item.milestoneName);
  return milestone === '' ? project : `${project} › ${milestone}`;
}

// "Due Oct 23, 2026 · 3 open · 2 unassigned" (the date part only when set).
function countsLine(item: DigestItem): string {
  const counts = `${item.openCount} open · ${item.unassignedCount} unassigned`;
  const target = item.notice.targetDate;
  return target === null
    ? counts
    : `Due ${escapeAndTruncate(formatDate(target), DATE_MAX)} · ${counts}`;
}

/**
 * Header text "<appName>: N milestone(s) need attention", ≤ 150 chars. The
 * app name is what gets shortened, so the count always survives.
 */
function renderHeaderText(appName: string, count: number): string {
  const suffix = `: ${count} ${count === 1 ? 'milestone needs' : 'milestones need'} attention`;
  const nameBudget = Math.max(
    SLACK_LIMITS.headerText - suffix.length,
    ELLIPSIS.length
  );
  return truncatePlain(singleLine(appName), nameBudget) + suffix;
}

/**
 * One item's section: bold linked title, kind line, the item's lines as
 * bullets, due date and counts, then the open issues by name (see
 * renderIssueBullets). Bullets that would push the text past 3000 chars are
 * replaced by "• …and N more". Room for the issue list's own "more" bullet
 * is kept while the lines are placed, so long lines never hide the issues
 * without saying how many there are.
 */
function renderSectionText(item: DigestItem): string {
  const title = `*${mrkdwnLink(item.url, itemLabel(item))}*`;
  const kind = describeItemKind(item);
  const counts = countsLine(item);
  const issues = unassignedFirst(item.openIssues ?? []);
  const issueReserve =
    issues.length === 0
      ? 0
      : 1 + moreIssuesBullet(issues.length, issues.length).length;

  const lines = item.lines.map(singleLine).filter((line) => line !== '');
  // Reserve room for the "more" bullet using the largest count it can show.
  const moreReserve = `\n• ${ELLIPSIS}and ${lines.length} more`.length;
  const bullets: string[] = [];
  let used = title.length + 1 + kind.length + 1 + counts.length + issueReserve;
  for (let i = 0; i < lines.length; i++) {
    const bullet = `• ${escapeAndTruncate(lines[i], LINE_MAX)}`;
    const reserve = i < lines.length - 1 ? moreReserve : 0;
    if (used + 1 + bullet.length + reserve > SLACK_LIMITS.sectionText) {
      bullets.push(`• ${ELLIPSIS}and ${lines.length - i} more`);
      break;
    }
    bullets.push(bullet);
    used += 1 + bullet.length;
  }

  const issueBullets = renderIssueBullets(
    issues,
    SLACK_LIMITS.sectionText - used + issueReserve
  );
  return [title, kind, ...bullets, counts, ...issueBullets].join('\n');
}

// Unassigned issues first (what a lead acts on), each group keeping the
// display order the digest gives.
function unassignedFirst(issues: readonly DigestIssue[]): DigestIssue[] {
  return [
    ...issues.filter((issue) => issue.unassigned),
    ...issues.filter((issue) => !issue.unassigned),
  ];
}

// "• <url|ENG-31> Wire the wizard — unassigned" (the marker only when no one
// is assigned); the title is kept to one line, escaped and capped.
function issueBullet(issue: DigestIssue): string {
  const key = mrkdwnLink(issue.url, singleLine(issue.identifier));
  const title = escapeAndTruncate(singleLine(issue.title), ISSUE_TITLE_MAX);
  const named = title === '' ? key : `${key} ${title}`;
  return `• ${named}${issue.unassigned ? ' — unassigned' : ''}`;
}

// "• …and 3 more open issues (2 unassigned)", the part in parentheses only
// when some of the rest are unassigned.
function moreIssuesBullet(count: number, unassigned: number): string {
  const noun = count === 1 ? 'issue' : 'issues';
  const tail = unassigned > 0 ? ` (${unassigned} unassigned)` : '';
  return `• ${ELLIPSIS}and ${count} more open ${noun}${tail}`;
}

/**
 * The open issues of one section as linked bullets (design §7.5: the message
 * says what is open and what is unassigned). At most ISSUES_MAX are named,
 * and only as many as fit in `budget` chars (each bullet costs its length
 * plus a newline); the rest are counted in a final moreIssuesBullet, which
 * always fits when `budget` covers the longest one this list can produce.
 */
function renderIssueBullets(
  issues: readonly DigestIssue[],
  budget: number
): string[] {
  const longestMore = 1 + moreIssuesBullet(issues.length, issues.length).length;
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < issues.length; i++) {
    const bullet = issueBullet(issues[i]);
    const reserve = i < issues.length - 1 ? longestMore : 0;
    if (i >= ISSUES_MAX || used + 1 + bullet.length + reserve > budget) {
      const rest = issues.slice(i);
      const unassigned = rest.filter((issue) => issue.unassigned).length;
      out.push(moreIssuesBullet(rest.length, unassigned));
      break;
    }
    out.push(bullet);
    used += 1 + bullet.length;
  }
  return out;
}

/**
 * Top-level `text`: the header line, then one compact line per item
 * ("• Project › Milestone — Overdue by 3 days"), cut with "…and N more" so
 * the whole stays ≤ 4000 chars. The header line is escaped but not cut: it
 * is ≤ 150 chars raw (≤ 750 escaped), and cutting it would lose the count.
 */
function renderSummaryText(
  headerText: string,
  items: readonly DigestItem[]
): string {
  let text = escapeMrkdwn(headerText);
  const moreReserve = `\n${ELLIPSIS}and ${items.length} more`.length;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const line = `\n• ${escapeAndTruncate(itemLabel(item), TEXT_LABEL_MAX)} — ${describeItemKind(item)}`;
    const reserve = i < items.length - 1 ? moreReserve : 0;
    if (text.length + line.length + reserve > SLACK_LIMITS.messageText) {
      text += `\n${ELLIPSIS}and ${items.length - i} more`;
      break;
    }
    text += line;
  }
  return text;
}
