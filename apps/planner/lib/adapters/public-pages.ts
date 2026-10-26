import {
  JOB_CLAIM_RETENTION_DAYS,
  NOTIFICATION_RETENTION_DAYS,
  type OperatorContact,
  PURGE_AFTER_DAYS,
  WEBHOOK_RETENTION_DAYS,
} from '@better-tracker/engine';

// The copy of the public pages (owner decision 2026-10-25, before
// strangers use the planner; architecture §8.4 "Public pages"): /privacy,
// /terms and /contact, readable signed out, plus the links and lines the
// landing page, Settings → Status and /setup carry to them. Everything is
// a pure function of PublicFacts (what the deployment's configuration
// says), so the words are tested without Next. The privacy page says what
// the code stores (packages/store/src/migrations.ts, the audit values of
// packages/engine/src/issue-edits.ts, the outbox, the logs) and how long,
// with every number taken from the engine's constants and the config;
// it changes with the mode (personal API keys store no Linear token, the
// demo is fictional) and names Slack only while a Slack channel is
// active. Plain words, not legal advice: the owner reviews them.

/** What the public pages say depends on. */
export interface PublicFacts {
  appName: string;
  /** How the planner reaches Linear: OAuth, personal API keys or the demo. */
  mode: 'oauth' | 'api_key' | 'demo';
  /** OPERATOR_NAME / OPERATOR_EMAIL / OPERATOR_URL (each may be null). */
  operator: OperatorContact;
  /** DEMO_URL, a public demo of the planner, or null. */
  demoUrl: string | null;
  /** SESSION_DAYS (OAuth and demo sessions). */
  sessionDays: number;
  /** Live digests go out as Slack DMs (engine.digestChannel()). */
  slack: boolean;
  /** api_key mode: how long a pasted key is held (idle, at most), in hours. */
  apiKeyHours: { idle: number; max: number } | null;
}

/** A link of the public pages' footer. */
export interface PublicLink {
  label: string;
  href: string;
}

/** The footer every signed-out page carries: privacy · terms · contact. */
export const POLICY_LINKS: readonly PublicLink[] = [
  { label: 'Privacy', href: '/privacy' },
  { label: 'Terms', href: '/terms' },
  { label: 'Contact', href: '/contact' },
];

/** The footer navigation's name. */
export const POLICY_LINKS_LABEL = 'About this planner';

/** A paragraph, a list or a two-column table of one section. */
export type PublicBlock =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: readonly string[] }
  | { kind: 'table'; label: string; rows: readonly [string, string][] };

/** A section of a public page: a heading and its blocks. */
export interface PublicSection {
  id: string;
  title: string;
  blocks: readonly PublicBlock[];
}

/** A public page: its heading, a lead line and the sections. */
export interface PublicPage {
  title: string;
  lead: string;
  sections: readonly PublicSection[];
}

function days(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

function hours(n: number): string {
  return n === 1 ? '1 hour' : `${n} hours`;
}

/** Who runs the planner, as a phrase ("Acme Ops", else a neutral one). */
export function operatorName(operator: OperatorContact): string {
  return operator.name ?? 'the person who runs this planner';
}

/**
 * The landing page's line on who runs the planner ("Run by Acme Ops."),
 * or null when OPERATOR_NAME is unset (the page then says nothing).
 */
export function operatorLine(operator: OperatorContact): string | null {
  return operator.name === null ? null : `Run by ${operator.name}.`;
}

/** /contact: who runs the planner and how to reach them. */
export function contactPage(facts: PublicFacts): PublicPage {
  const { operator } = facts;
  const known =
    operator.name !== null || operator.email !== null || operator.url !== null;
  const blocks: PublicBlock[] = known
    ? [
        {
          kind: 'text',
          text:
            operator.name === null
              ? `${facts.appName} is run independently of Linear. To ask about it, about your data or to have it deleted, write to its operator.`
              : `${facts.appName} is run by ${operator.name}, independently of Linear. To ask about it, about your data or to have it deleted, write to them.`,
        },
      ]
    : [
        {
          kind: 'text',
          text: `The person who runs ${facts.appName} has not published contact details here. If your workspace uses it, ask your Linear workspace admin who set it up.`,
        },
      ];
  return {
    title: 'Contact',
    lead: `Who runs ${facts.appName} and how to reach them. Linear does not run it and cannot answer for it.`,
    sections: [{ id: 'who', title: 'Who runs it', blocks }],
  };
}

/** The email and website rows /contact shows under its sentence. */
export function contactDetails(
  operator: OperatorContact
): { id: 'email' | 'url'; label: string; value: string; href: string }[] {
  const rows: {
    id: 'email' | 'url';
    label: string;
    value: string;
    href: string;
  }[] = [];
  if (operator.email !== null) {
    rows.push({
      id: 'email',
      label: 'Email',
      value: operator.email,
      href: `mailto:${operator.email}`,
    });
  }
  if (operator.url !== null) {
    rows.push({
      id: 'url',
      label: 'Website',
      value: operator.url,
      href: operator.url,
    });
  }
  return rows;
}

/** What the planner copies from Linear (every mode but the demo). */
function mirrorItems(): string[] {
  return [
    'Teams and who is in each, and their workflow states.',
    'People: names, display names, email addresses, avatar URLs, and whether each is active, a guest or an app.',
    'Initiatives, projects (names, leads, status, dates) and project milestones (names, descriptions, target dates).',
    'Issues: identifier, title, team, project, milestone, assignee, state, priority, due date and when they were created, started, finished or canceled, and the blocking relations between them.',
    'Not stored: issue descriptions, comments, labels and estimates. They are read from Linear when someone opens an issue, with that person’s own access.',
  ];
}

/** What the planner adds to that copy (every mode). */
function plannerItems(facts: PublicFacts): string[] {
  const items = [
    'Each milestone’s “done means…” text and weight, and the workspace’s settings (modes, watchers, schedule, timezone).',
    'The run log: every allocation run and what it assigned, skipped or blocked, with issue identifiers and titles and Linear user ids.',
    'The audit log: every change made through the planner, with who made it and when. Issue edits keep the old and new value (titles in full, labels by name); descriptions and comments only as a length in characters, never their words.',
    'What each warning last announced, so a milestone is not announced every day.',
  ];
  if (facts.mode === 'api_key') {
    items.push(
      'No digests: with personal API keys warnings are a preview only, and a preview is not recorded.'
    );
  } else {
    items.push(
      facts.slack
        ? 'The daily digests, each with its recipient’s name and email address and the milestones it names, whether sent over Slack or kept in the planner’s outbox.'
        : 'The daily digests, each with its recipient’s name and email address and the milestones it names, kept in the planner’s outbox.'
    );
  }
  return items;
}

/** /privacy: what is stored, where, for how long, and how to delete it. */
export function privacyPage(facts: PublicFacts): PublicPage {
  const app = facts.appName;
  const contact = `contact ${operatorName(facts.operator)} (see Contact)`;
  const sections: PublicSection[] = [];

  if (facts.mode === 'demo') {
    sections.push(
      {
        id: 'demo',
        title: 'This is a demo',
        blocks: [
          {
            kind: 'text',
            text: `This ${app} serves a fictional workspace: its people, projects and issues are made up, and nothing here reaches a real Linear account. Signing in as a demo person keeps a session for them on this server; what you change is kept by this server alone and is part of the demo.`,
          },
          {
            kind: 'text',
            text: 'Nothing about you is asked for: no Linear account, no email address. The planner itself stores no client IP address; the host’s request logs do (see Logs).',
          },
        ],
      },
      {
        id: 'logs',
        title: 'Logs',
        blocks: [
          {
            kind: 'text',
            text: 'The host keeps the server’s logs, which name demo people and issues by id. The host’s (Railway’s) request logs also record every request’s client IP address, browser user agent and the page or API path it asked for. They are kept for as long as the host keeps them.',
          },
        ],
      }
    );
    return {
      title: 'Privacy',
      lead: `What this demo of ${app} keeps.`,
      sections,
    };
  }

  const linearCopy: PublicBlock[] = [
    {
      kind: 'text',
      text:
        facts.mode === 'api_key'
          ? `${app} keeps a copy of what it reads from Linear with a member’s personal API key, so pages load without asking Linear every time:`
          : `${app} keeps a copy of what it reads from Linear for each workspace that installed it (only the teams the installing admin chose), so pages load without asking Linear every time:`,
    },
    { kind: 'list', items: mirrorItems() },
  ];
  sections.push({
    id: 'linear',
    title: 'What it copies from Linear',
    blocks: linearCopy,
  });

  sections.push({
    id: 'planner',
    title: 'What it adds',
    blocks: [{ kind: 'list', items: plannerItems(facts) }],
  });

  if (facts.mode === 'api_key') {
    const held =
      facts.apiKeyHours === null
        ? ''
        : ` It is forgotten after ${hours(facts.apiKeyHours.idle)} without use and at most ${hours(facts.apiKeyHours.max)} after you connect, or when you sign out.`;
    sections.push({
      id: 'access',
      title: 'Your Linear key',
      blocks: [
        {
          kind: 'text',
          text: `The personal API key you paste is held only in the server’s memory, never written to its database, disk or logs, and never sent back to your browser.${held} A restart forgets every key.`,
        },
        {
          kind: 'text',
          text: 'Your browser keeps a random session cookie; the server holds only a hash of it, in memory, with your Linear user id and name.',
        },
      ],
    });
  } else {
    sections.push({
      id: 'access',
      title: 'Sign-in and access',
      blocks: [
        {
          kind: 'list',
          items: [
            `For each person who signs in: their Linear user id and name, the workspace’s name, and their Linear access and refresh tokens, encrypted (AES-256-GCM). Your browser keeps a random session cookie; the database keeps only its SHA-256 hash.`,
            'For each workspace: the app’s own Linear tokens, encrypted the same way, the app’s Linear user id, and who installed it and when.',
            `Webhook records: for each delivery from Linear, its type, action and the id of what changed.`,
            'Sync records: when the copy was last refreshed, how long it took, how many issues it holds, and the error when a refresh failed.',
            'Which workspaces the planner admits or blocks: for a workspace admitted by its URL key, that URL key and the Linear workspace id it was matched to; for a blocked one, its Linear workspace id and URL key, with the reason given for the block.',
          ],
        },
      ],
    });
  }

  const memory: string[] = [];
  // The planner's own copies of client IPs (lib/rate-limit.ts,
  // lib/connect-limit.ts): in memory, counted over these windows, and
  // dropped only when a later request on the same count finds them
  // expired, when too many are held, or at a restart.
  if (facts.mode === 'oauth') {
    memory.push(
      'Client IP addresses, which the planner keeps only in its memory (never in its database), to count sign-in starts and workspace switches over 10 minutes and refused webhook deliveries over a minute. An address can stay in memory after its window until a later request on the same count clears it; a restart forgets them all.'
    );
  } else {
    memory.push(
      'Client IP addresses of failed connects, which the planner keeps only in its memory (never in its database), to slow down guessing over 10 minutes. An address can stay in memory after that until a later connect clears it; a restart forgets them all.'
    );
  }
  memory.push(
    'The host’s logs: the planner’s own lines name workspaces and people by Linear id, issues by identifier, and errors. The host’s (Railway’s) request logs also record every request’s client IP address, browser user agent and the page or API path it asked for. They are kept for as long as the host keeps them.'
  );
  sections.push({
    id: 'memory',
    title: 'Logs and memory',
    blocks: [{ kind: 'list', items: memory }],
  });

  const where: string[] = [
    'The web service, the worker and the Postgres database run on Railway.',
    'Linear holds the original of everything the planner copies.',
  ];
  if (facts.slack) {
    where.push(
      'Slack: digests are sent as Slack direct messages, so Slack receives each recipient’s email address (to find them) and the digest’s text.'
    );
  }
  sections.push({
    id: 'where',
    title: 'Where it is kept',
    blocks: [{ kind: 'list', items: where }],
  });

  const rows: [string, string][] =
    facts.mode === 'api_key'
      ? [
          [
            'Your key and session',
            facts.apiKeyHours === null
              ? 'In memory, until you sign out or the server restarts'
              : `In memory, ${hours(facts.apiKeyHours.idle)} idle and at most ${hours(facts.apiKeyHours.max)}`,
          ],
          [
            'The copy of Linear, settings, the run log and the audit log',
            'While the planner serves the workspace',
          ],
        ]
      : [
          ['A session', `${days(facts.sessionDays)}, or until you sign out`],
          ['Webhook records', days(WEBHOOK_RETENTION_DAYS)],
          ['Digests', days(NOTIFICATION_RETENTION_DAYS)],
          ['Daily run records', days(JOB_CLAIM_RETENTION_DAYS)],
          [
            'The copy of Linear, settings, the run log and the audit log',
            'While the workspace has the app installed',
          ],
          [
            'Everything else about a workspace after it uninstalls the app',
            `Deleted ${days(PURGE_AFTER_DAYS)} after Linear tells the planner about the uninstall, unless it is installed again first`,
          ],
          [
            'Which workspaces are admitted or blocked (a Linear workspace id with a URL key, and a block’s reason)',
            'Kept with no time limit, also after the rest of the workspace is deleted, so an admission or a block keeps naming the same workspace after a rename; ask the person who runs the planner to remove them',
          ],
          [
            'Everything about a workspace whose app access Linear refused with no uninstall notice',
            'Kept until the person who runs the planner removes it (ask them); sessions last until they expire',
          ],
        ];
  sections.push({
    id: 'retention',
    title: 'How long',
    blocks: [
      { kind: 'table', label: 'How long each kind is kept', rows },
      {
        kind: 'text',
        text: 'Database backups, when the person who runs the planner turns them on, can keep data for longer than this.',
      },
    ],
  });

  sections.push({
    id: 'delete',
    title: 'How to have it deleted',
    blocks:
      facts.mode === 'api_key'
        ? [
            {
              kind: 'text',
              text: 'Signing out forgets your key at once, on every device. Revoke the key in Linear (Settings → Security & access → Personal API keys) to end it there too.',
            },
            {
              kind: 'text',
              text: `For the rest (the copy of Linear, the logs), ${contact}.`,
            },
          ]
        : [
            {
              kind: 'text',
              text: 'Signing out ends your session and revokes the planner’s access to your Linear account.',
            },
            {
              kind: 'text',
              text: `A workspace admin can uninstall the app in Linear’s settings. When Linear tells the planner about the uninstall, the planner stops reading the workspace, signs everyone out of it, and deletes what it holds about the workspace ${days(PURGE_AFTER_DAYS)} later, except which workspace id and URL key an admission or a block names (see How long). If that notice never arrives (Linear then only refuses the app’s access), the planner stops reading the workspace but keeps what it holds until the person who runs it removes the workspace, and people’s sessions last until they expire. To have it deleted sooner, to make sure it is deleted after an uninstall, or to ask what is held about you, ${contact}.`,
            },
          ],
  });

  return {
    title: 'Privacy',
    lead: `What ${app} stores about a Linear workspace and the people in it, where, for how long, and how to have it deleted.`,
    sections,
  };
}

/** /terms: as is, what it writes to Linear, acceptable use, removal. */
export function termsPage(facts: PublicFacts): PublicPage {
  const app = facts.appName;
  const who = operatorName(facts.operator);
  const writes: string[] =
    facts.mode === 'api_key'
      ? [
          'Allocation, only when someone starts a run while allocation is switched to live in Settings: it assigns a project’s next-milestone issues to the project lead, moves them from Backlog to Todo and comments why, with the personal API key of the person who started it. Nothing runs on a schedule.',
          'The edits people make themselves (milestone dates, project leads, issue fields, comments and blocking relations), each with that person’s own key.',
        ]
      : [
          'Allocation, only once someone switches it to live in Settings (it starts as a dry run that writes nothing): the daily run, and Run now, assign a project’s next-milestone issues to the project lead, move them from Backlog to Todo and add a comment saying why, as the app’s own Linear user. The person who runs the planner can also start that run by hand for one workspace; where Settings still says dry run, it writes only when they deliberately override that.',
          'The edits people make themselves (milestone dates, project leads, issue fields, comments and blocking relations), each with that person’s own Linear access.',
        ];
  const sections: PublicSection[] = [
    {
      id: 'as-is',
      title: 'Provided as is',
      blocks: [
        {
          kind: 'text',
          text: `${app} is provided as is, without any warranty. There is no promise of uptime: it may be slow, unavailable or stop altogether, and its copy of Linear may lag behind Linear.`,
        },
      ],
    },
    {
      id: 'writes',
      title: 'What it writes to Linear',
      blocks: [
        {
          kind: 'text',
          text:
            facts.mode === 'demo'
              ? 'This is a demo: nothing reaches a real Linear account. In a real deployment, Linear stays the source of truth and the planner writes to it only:'
              : 'Linear stays the source of truth. The planner writes to it only:',
        },
        { kind: 'list', items: writes },
      ],
    },
    {
      id: 'use',
      title: 'Acceptable use',
      blocks: [
        {
          kind: 'text',
          text: `Use ${app} to plan work in Linear workspaces you belong to. Do not try to reach a workspace you are not part of, overload it (it limits how often anyone can sign in or make changes), probe it for weaknesses without permission from ${who}, or use it in a way that breaks Linear’s own terms.`,
        },
      ],
    },
  ];
  if (facts.mode === 'oauth') {
    sections.push({
      id: 'removal',
      title: 'Removal',
      blocks: [
        {
          kind: 'text',
          text: `${capitalised(who)} may remove a workspace (everyone is signed out of it, and its data is deleted ${days(PURGE_AFTER_DAYS)} later unless it is installed again) or block it from using the planner at all, for example to stop abuse, and may stop the planner at any time.`,
        },
      ],
    });
  } else {
    sections.push({
      id: 'removal',
      title: 'Removal',
      blocks: [
        {
          kind: 'text',
          text: `${capitalised(who)} may stop the planner, or end anyone’s use of it, at any time.`,
        },
      ],
    });
  }
  sections.push({
    id: 'changes',
    title: 'Changes',
    blocks: [
      {
        kind: 'text',
        text: 'These terms may change; this page always shows the current ones.',
      },
    ],
  });
  return {
    title: 'Terms',
    lead: `The terms of using ${app}. They are plain words, not legal advice.`,
    sections,
  };
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The landing page's line on what the planner stores (OAuth mode), before
 * its link to /privacy.
 */
export const LANDING_STORES_LINE =
  'It keeps a copy of what it reads from Linear, and your Linear sign-in encrypted.';

/** The link after it. */
export const LANDING_PRIVACY_LINK = 'What it stores and for how long';

/** The landing page's line for admins (OAuth mode). */
export const LANDING_ADMIN_LINE =
  'Admins: sign in, then install it for your workspace.';

/** The hint under "Sign in with Linear" (OAuth mode). */
export const LANDING_CONNECT_HINT =
  'Linear signs you in to the workspace you have open at linear.app. Open the one you want there first.';

/** The landing page's link to DEMO_URL, when set. */
export const LANDING_DEMO_LINK = 'Try the demo first';
