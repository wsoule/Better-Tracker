import type { Engine } from '@better-tracker/engine';
import {
  JOB_CLAIM_RETENTION_DAYS,
  NOTIFICATION_RETENTION_DAYS,
  PURGE_AFTER_DAYS,
  WEBHOOK_RETENTION_DAYS,
} from '@better-tracker/engine';
import { ToastProvider } from '@better-tracker/ui';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { landingFeatures } from '../lib/adapters/landing';
import {
  contactDetails,
  contactPage,
  LANDING_ADMIN_LINE,
  LANDING_CONNECT_HINT,
  operatorLine,
  POLICY_LINKS,
  privacyPage,
  type PublicFacts,
  type PublicPage,
  termsPage,
} from '../lib/adapters/public-pages';
import { digestPreview, warningsConsequence } from '../lib/adapters/settings';
import {
  type FakeEngineState,
  fakeEngine,
  freshState,
} from './auth-fake-engine';

// The public pages and stranger-facing copy (owner decision 2026-10-25;
// architecture §8.4 "Public pages"): /privacy, /terms and /contact render
// without a session and touch nothing but the engine's configuration and
// its digest channel (no cookie, no session, no Linear call); the privacy
// page's numbers are the engine's constants and SESSION_DAYS; Slack is
// promised only while a Slack channel is active; the landing page carries
// the lines for strangers.

let cookiesRead = 0;
let jar: Record<string, string> = {};
void mock.module('next/headers', () => ({
  cookies: () => {
    cookiesRead += 1;
    return Promise.resolve({
      get: (name: string) =>
        jar[name] === undefined ? undefined : { name, value: jar[name] },
    });
  },
  headers: () => Promise.resolve(new Headers({ 'x-nonce': 'test-nonce' })),
}));
const realServer = await import('next/server');
void mock.module('next/server', () => ({
  ...realServer,
  connection: () => Promise.resolve(),
}));
// next/font only works inside Next's compiler: the layout's fonts are
// stand-ins here.
void mock.module('next/font/google', () => ({
  Geist: () => ({ variable: 'font-geist', className: 'font-geist' }),
  Geist_Mono: () => ({
    variable: 'font-geist-mono',
    className: 'font-geist-mono',
  }),
}));
class Redirect extends Error {}
const realNavigation = await import('next/navigation');
void mock.module('next/navigation', () => ({
  ...realNavigation,
  redirect: (url: string) => {
    throw new Redirect(url);
  },
  notFound: () => {
    throw new Redirect('not-found');
  },
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(''),
}));

const { default: PublicLayout } = await import('../app/(public)/layout');
const { default: PrivacyPage } = await import('../app/(public)/privacy/page');
const { default: TermsPage } = await import('../app/(public)/terms/page');
const { default: ContactPage } = await import('../app/(public)/contact/page');
const { default: HomePage } = await import('../app/(app)/page');

const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;
afterAll(() => {
  holder.__milestonePlannerEngine = savedEngine;
});

const OPERATOR = {
  name: 'Acme Ops',
  email: 'ops@acme.example',
  url: 'https://acme.example/planner',
};
const NO_OPERATOR = { name: null, email: null, url: null };

interface EngineSetup {
  mode?: 'linear' | 'fixture';
  auth?: 'oauth' | 'api_key' | 'demo';
  slack?: boolean;
  operator?: PublicFacts['operator'];
  demoUrl?: string | null;
  sessionDays?: number;
}

/** What every public page may read of the engine; anything else throws. */
const ALLOWED = new Set(['config', 'mode', 'digestChannel', 'then']);
const touched: string[] = [];

/**
 * An engine that answers only its configuration and digest channel and
 * throws on any other property: the public pages read nothing else (no
 * session, no Linear, no workspace data).
 */
function publicEngine(setup: EngineSetup = {}): Engine {
  const auth = setup.auth ?? 'oauth';
  const target = {
    mode: setup.mode ?? (auth === 'demo' ? 'fixture' : 'linear'),
    config: {
      appName: 'Milestone Planner',
      appUrl: 'https://planner.example.com',
      auth,
      sessionDays: setup.sessionDays ?? 30,
      apiKey:
        auth === 'api_key'
          ? { idleMs: 2 * 3_600_000, absoluteMs: 12 * 3_600_000 }
          : null,
      operator: setup.operator ?? NO_OPERATOR,
      demoUrl: setup.demoUrl ?? null,
      defaultTimezone: 'UTC',
    },
    digestChannel: () =>
      Promise.resolve(setup.slack === true ? 'slack' : 'outbox'),
  };
  return new Proxy(target, {
    get(object, property) {
      if (typeof property === 'string' && !ALLOWED.has(property)) {
        touched.push(property);
        throw new Error(`a public page called engine.${property}`);
      }
      return Reflect.get(object, property) as unknown;
    },
  }) as unknown as Engine;
}

function isAsync(
  type: unknown
): type is (props: unknown) => Promise<ReactNode> {
  return (
    typeof type === 'function' && type.constructor.name === 'AsyncFunction'
  );
}

/** Resolves the async server components in a tree, then renders it. */
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Record<string, unknown>>;
  if (isAsync(element.type)) {
    return resolve(await element.type(element.props));
  }
  const props: Record<string, unknown> = {};
  let changed = false;
  for (const [key, value] of Object.entries(element.props)) {
    if (isValidElement(value) || Array.isArray(value)) {
      props[key] = await resolve(value as ReactNode);
      changed = true;
    }
  }
  if (!changed) return element;
  const { children, ...rest } = props;
  return children === undefined
    ? cloneElement(element, rest)
    : cloneElement(element, rest, ...Children.toArray(children as ReactNode));
}

async function render(node: Promise<ReactNode> | ReactNode): Promise<string> {
  const tree = await resolve(await node);
  return renderToStaticMarkup(<ToastProvider>{tree}</ToastProvider>);
}

/** The visible text of rendered markup, tags dropped and entities read. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function pageText(page: PublicPage): string {
  return [
    page.title,
    page.lead,
    ...page.sections.flatMap((section) => [
      section.title,
      ...section.blocks.flatMap((block) =>
        block.kind === 'text'
          ? [block.text]
          : block.kind === 'list'
            ? [...block.items]
            : block.rows.flat()
      ),
    ]),
  ].join(' ');
}

function facts(overrides: Partial<PublicFacts> = {}): PublicFacts {
  return {
    appName: 'Milestone Planner',
    mode: 'oauth',
    operator: NO_OPERATOR,
    demoUrl: null,
    sessionDays: 30,
    slack: false,
    apiKeyHours: null,
    ...overrides,
  };
}

beforeEach(() => {
  cookiesRead = 0;
  touched.length = 0;
  jar = {};
});

describe('the public pages render without a session', () => {
  test('/privacy, /terms and /contact read no cookie and call nothing but the configuration', async () => {
    holder.__milestonePlannerEngine = Promise.resolve(
      publicEngine({ operator: OPERATOR })
    );
    for (const page of [PrivacyPage, TermsPage, ContactPage]) {
      const html = await render(page());
      expect(html).toContain('<h1');
    }
    const layout = await render(PublicLayout({ children: <p>Page body</p> }));
    expect(layout).toContain('Page body');
    expect(cookiesRead).toBe(0);
    expect(touched).toEqual([]);
  });

  test('the layout carries the nonce on its theme script and the policy footer', async () => {
    holder.__milestonePlannerEngine = Promise.resolve(publicEngine());
    const html = await render(PublicLayout({ children: <p>x</p> }));
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts)
      expect(script).toContain('nonce="test-nonce"');
    expect(html).toContain('<nav aria-label="About this planner">');
    for (const link of POLICY_LINKS) {
      expect(html).toContain(`href="${link.href}"`);
    }
  });

  test('/contact shows the operator, with a mailto and a website link', async () => {
    holder.__milestonePlannerEngine = Promise.resolve(
      publicEngine({ operator: OPERATOR })
    );
    const html = await render(ContactPage());
    expect(text(html)).toContain('Milestone Planner is run by Acme Ops');
    expect(html).toContain('href="mailto:ops@acme.example"');
    expect(html).toContain('href="https://acme.example/planner"');
  });

  test('/contact without OPERATOR_* says so neutrally, with no empty links', async () => {
    holder.__milestonePlannerEngine = Promise.resolve(publicEngine());
    const html = await render(ContactPage());
    expect(text(html)).toContain('has not published contact details here');
    expect(html).not.toContain('mailto:');
    expect(contactDetails(NO_OPERATOR)).toEqual([]);
  });
});

describe('the privacy page says what the code keeps', () => {
  test('every number comes from the engine constants and SESSION_DAYS', () => {
    for (const sessionDays of [30, 14]) {
      const page = privacyPage(facts({ sessionDays }));
      const rows = page.sections
        .flatMap((section) => section.blocks)
        .flatMap((block) => (block.kind === 'table' ? block.rows : []));
      const row = (label: string): string =>
        rows.find(([name]) => name === label)?.[1] ?? '';
      expect(row('A session')).toBe(
        `${sessionDays} days, or until you sign out`
      );
      expect(row('Webhook records')).toBe(`${WEBHOOK_RETENTION_DAYS} days`);
      expect(row('Digests')).toBe(`${NOTIFICATION_RETENTION_DAYS} days`);
      expect(row('Daily run records')).toBe(`${JOB_CLAIM_RETENTION_DAYS} days`);
      expect(
        row('Everything about a workspace after it uninstalls the app')
      ).toContain(`${PURGE_AFTER_DAYS} days later`);
      expect(
        row('The copy of Linear, settings, the run log and the audit log')
      ).toBe('While the workspace has the app installed');
    }
  });

  test('it names what is stored and what is not, in OAuth mode', () => {
    const copy = pageText(privacyPage(facts()));
    for (const phrase of [
      'email addresses',
      'avatar URLs',
      'milestones (names, descriptions, target dates)',
      'blocking relations',
      '“done means…” text and weight',
      'encrypted (AES-256-GCM)',
      'SHA-256 hash',
      'descriptions and comments only as a length in characters',
      'recipient’s name and email address',
      'Client IP addresses, in the web server’s memory only',
      'Railway',
      'Not stored: issue descriptions, comments, labels and estimates',
    ]) {
      expect(copy).toContain(phrase);
    }
  });

  test('Slack is named only while a Slack channel is active', () => {
    expect(pageText(privacyPage(facts()))).not.toContain('Slack');
    expect(pageText(privacyPage(facts({ slack: true })))).toContain(
      'Slack receives each recipient’s email address'
    );
  });

  test('personal API keys: no Linear token is stored, the key lives in memory', () => {
    const copy = pageText(
      privacyPage(facts({ mode: 'api_key', apiKeyHours: { idle: 2, max: 12 } }))
    );
    expect(copy).toContain('held only in the server’s memory');
    expect(copy).toContain('2 hours without use and at most 12 hours');
    expect(copy).not.toContain('AES-256-GCM');
    expect(copy).not.toContain('Webhook records');
    expect(copy).toContain('No digests');
  });

  test('the demo is fictional and keeps nothing about the visitor', () => {
    const copy = pageText(privacyPage(facts({ mode: 'demo' })));
    expect(copy).toContain('fictional workspace');
    expect(copy).toContain('no client IP address');
    expect(copy).not.toContain('AES-256-GCM');
  });

  test('deletion points at the operator when named, a neutral phrase otherwise', () => {
    expect(pageText(privacyPage(facts({ operator: OPERATOR })))).toContain(
      'contact Acme Ops (see Contact)'
    );
    expect(pageText(privacyPage(facts()))).toContain(
      'contact the person who runs this planner (see Contact)'
    );
  });
});

describe('the terms', () => {
  test('as is, the Linear writes, acceptable use and removal by whoever runs it', () => {
    const copy = pageText(termsPage(facts({ operator: OPERATOR })));
    expect(copy).toContain('provided as is');
    expect(copy).toContain('no promise of uptime');
    expect(copy).toContain('only once someone switches it to live');
    expect(copy).toContain('each with that person’s own Linear access');
    expect(copy).toContain('Acme Ops may remove a workspace');
    expect(copy).toContain(`deleted ${PURGE_AFTER_DAYS} days later`);
    const keys = pageText(termsPage(facts({ mode: 'api_key' })));
    expect(keys).toContain('Nothing runs on a schedule');
    expect(keys).not.toContain('remove a workspace');
  });

  test('contact page copy without an operator', () => {
    expect(pageText(contactPage(facts()))).toContain(
      'ask your Linear workspace admin who set it up'
    );
  });
});

describe('the landing page for strangers', () => {
  test('signed out (OAuth): the hint, what is stored, the admin line and the policy links', async () => {
    holder.__milestonePlannerEngine = Promise.resolve(
      landingEngine({ operator: OPERATOR, demoUrl: 'https://demo.example' })
    );
    const html = await render(HomePage({ searchParams: Promise.resolve({}) }));
    const words = text(html);
    expect(words).toContain(LANDING_CONNECT_HINT);
    expect(words).toContain(LANDING_ADMIN_LINE);
    expect(html).toContain('href="/privacy"');
    expect(words).toContain('Run by Acme Ops.');
    expect(html).toContain('href="https://demo.example"');
    expect(words).not.toContain('Slack');
    expect(words).toContain('in a daily digest in the planner');
  });

  test('the warnings card promises Slack only while a Slack channel is active', async () => {
    holder.__milestonePlannerEngine = Promise.resolve(
      landingEngine({ slack: true })
    );
    const html = await render(HomePage({ searchParams: Promise.resolve({}) }));
    expect(text(html)).toContain('in a daily Slack digest');
    expect(text(html)).not.toContain('Run by');
    for (const options of [{ apiKeyMode: false }, { apiKeyMode: true }]) {
      const copy = landingFeatures(options)
        .map((feature) => feature.body)
        .join(' ');
      expect(copy).not.toContain('Slack');
    }
  });

  test('an error only the operator can fix links to /contact', async () => {
    holder.__milestonePlannerEngine = Promise.resolve(landingEngine());
    const html = await render(
      HomePage({
        searchParams: Promise.resolve({ auth_error: 'workspace_not_allowed' }),
      })
    );
    expect(text(html)).toContain(
      'This planner is not open to that Linear workspace yet. Ask the person who runs it.'
    );
    expect(html).toContain('href="/contact"');
    const limited = await render(
      HomePage({
        searchParams: Promise.resolve({ auth_error: 'auth_rate_limited' }),
      })
    );
    expect(text(limited)).toContain('Too many sign-in or workspace switch');
  });

  test('operatorLine says nothing without OPERATOR_NAME', () => {
    expect(operatorLine(NO_OPERATOR)).toBeNull();
    expect(operatorLine(OPERATOR)).toBe('Run by Acme Ops.');
  });
});

describe('settings copy names Slack only while it is used', () => {
  test('the warnings switch and the digest preview', () => {
    expect(warningsConsequence('live', true)).toContain('Slack DM');
    expect(warningsConsequence('live', false)).not.toContain('Slack');
    expect(warningsConsequence('live', false)).toContain(
      'kept in the planner’s outbox'
    );
    expect(warningsConsequence('preview', true)).not.toContain('Slack');
    const result = { day: '2026-10-26', mode: 'live' as const, digests: [] };
    expect(digestPreview(result).summary).not.toContain('Slack');
    expect(digestPreview(result).summary).toContain('planner’s outbox');
    expect(digestPreview(result, { slack: true }).summary).toContain(
      'Slack DMs'
    );
  });
});

let state: FakeEngineState;

/**
 * The landing page's engine: the auth fake (OAuth mode, signed out) with
 * the configuration the stranger-facing lines read.
 */
function landingEngine(setup: EngineSetup = {}): Engine {
  state = freshState();
  const base = fakeEngine(state);
  const engine = Object.create(base) as Engine;
  Object.defineProperty(engine, 'config', {
    value: {
      ...base.config,
      sessionDays: 30,
      apiKey: null,
      operator: setup.operator ?? NO_OPERATOR,
      demoUrl: setup.demoUrl ?? null,
    },
  });
  return Object.assign(engine, {
    digestChannel: () =>
      Promise.resolve(setup.slack === true ? 'slack' : 'outbox'),
    listDemoUsers: () => Promise.resolve([]),
    listWorkspaceIds: () => Promise.resolve([]),
    getInstallation: () => Promise.resolve(null),
  });
}
