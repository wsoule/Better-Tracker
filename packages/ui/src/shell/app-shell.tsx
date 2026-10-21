'use client';

import {
  Ellipsis,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  X,
} from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import StatusMark from '../components/status-mark';
import ThemeToggle from '../components/theme-toggle';
import { Link } from '../lib/link';
import styles from './app-shell.module.css';
import { useOptionalCommandPalette } from './command-palette';
import {
  isTypingTarget,
  modalIsOpen,
  PHONE_QUERY,
  readStorage,
  trapTab,
  useDialogFocus,
  useMediaQuery,
  useModKeyLabel,
  useScrollLock,
  writeStorage,
} from './dom';
import { KbdKeys } from './kbd';
import { cx, renderIcon } from './render';
import type {
  AppShellProps,
  ShellNavItem,
  ShellSection,
  ShellUser,
} from './types';

/* One primary-nav row: icon, mono label, count; the shortcut shows on
   hover. `data-tip` feeds the rail tooltip when the sidebar is collapsed. */
function NavRow({ item }: { item: ShellNavItem }): ReactNode {
  const showCount = item.count !== undefined && item.count > 0;
  return (
    <li data-tip={item.label}>
      <Link
        href={item.href}
        className={styles.item}
        aria-current={item.current === true ? 'page' : undefined}
      >
        <span className={styles.icon}>{renderIcon(item.icon)}</span>
        <span className={styles.label}>{item.label}</span>
        {showCount ? (
          <span
            className={cx(
              styles.count,
              item.countTone === 'accent' && styles.countAccent
            )}
          >
            <span aria-hidden="true">{item.count}</span>
            <span className="srOnly">{`, ${item.countLabel ?? String(item.count)}`}</span>
          </span>
        ) : null}
        {item.shortcut !== undefined && item.shortcut.length > 0 ? (
          <span className={styles.hint} aria-hidden="true">
            <KbdKeys keys={item.shortcut} />
          </span>
        ) : null}
      </Link>
    </li>
  );
}

/* A titled sidebar list (PROJECTS): status mark + name per row. */
function SectionList({
  section,
  headingId,
}: {
  section: ShellSection;
  headingId: string;
}): ReactNode {
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <div className={styles.sectionHead}>
        <h2 id={headingId} className={styles.sectionTitle}>
          {section.title}
        </h2>
        {section.action !== undefined ? (
          // "All" alone is meaningless out of context (a screen reader's
          // links list), so the section title completes its name.
          <Link href={section.action.href} className={styles.sectionAction}>
            {section.action.label}
            <span className="srOnly">{` ${section.title}`}</span>
          </Link>
        ) : null}
      </div>
      {section.items.length === 0 ? (
        <p className={styles.sectionEmpty}>
          {section.emptyLabel ?? 'Nothing here yet'}
        </p>
      ) : (
        <ul className={styles.list}>
          {section.items.map((item) => (
            <li key={item.id} data-tip={`${item.label} · ${item.statusLabel}`}>
              <Link
                href={item.href}
                className={cx(styles.item, styles.sectionItem)}
                aria-current={item.current === true ? 'page' : undefined}
              >
                <span className={styles.icon}>
                  <StatusMark status={item.status} label={item.statusLabel} />
                </span>
                <span className={styles.label}>{item.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Up to two initials for the square avatar. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => part !== '')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function UserBlock({ user }: { user: ShellUser }): ReactNode {
  const inner = (
    <>
      <span className={styles.avatar} aria-hidden="true">
        {initials(user.name)}
      </span>
      <span className={styles.userName}>{user.name}</span>
      {user.badge !== undefined && user.badge !== '' ? (
        <span className={styles.badge}>{user.badge}</span>
      ) : null}
    </>
  );
  return (
    <span className={styles.userWrap} data-tip={user.name}>
      {user.href !== undefined ? (
        <Link href={user.href} className={styles.user}>
          {inner}
        </Link>
      ) : (
        <span className={styles.user}>{inner}</span>
      )}
    </span>
  );
}

/**
 * Whether the rail is collapsed. <html data-shell-collapsed> is the source
 * of truth (the rail CSS keys off it, and sidebarCollapseScript() can set
 * it before React hydrates); without it, the saved choice, then the
 * default. Storage failures fall back to the default.
 */
function readCollapsed(
  storageKey: string | undefined,
  fallback: boolean
): boolean {
  const attr = document.documentElement.dataset.shellCollapsed;
  if (attr === 'true' || attr === 'false') return attr === 'true';
  const saved = storageKey === undefined ? null : readStorage(storageKey);
  return saved === '1' ? true : saved === '0' ? false : fallback;
}

/** Re-renders when anything (a script, another shell) flips the attribute. */
function subscribeCollapsed(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-shell-collapsed'],
  });
  return () => observer.disconnect();
}

interface RailTip {
  label: string;
  top: number;
}

/**
 * The app frame (architecture §8.3): a fixed 252px hatched sidebar — brand
 * row, primary nav, titled sections, footer (settings, user, theme, sign
 * out) — beside a 46px topbar (breadcrumb, search trigger) and the content.
 *
 * Desktop: "[" (or the brand-row button) collapses the sidebar to a 52px
 * icon rail, remembered under `storageKey`. Phone (≤ 900px): the sidebar is
 * an off-canvas drawer behind the topbar menu button (a modal dialog: Esc
 * and the scrim close it, Tab stays inside) and a bottom tab bar holds the
 * main destinations plus "More", which opens the drawer.
 */
export default function AppShell({
  appName,
  workspaceName,
  brandHref,
  nav,
  sections = [],
  settings,
  user,
  signOut,
  themeStorageKey,
  footer,
  crumbs = [],
  topbarActions,
  onSearch,
  searchLabel = 'Search or jump to…',
  banner,
  tabs,
  moreLabel = 'More',
  storageKey,
  defaultCollapsed = false,
  mainId = 'main',
  children,
}: AppShellProps): ReactNode {
  const palette = useOptionalCommandPalette();
  const openSearch = onSearch ?? palette?.open;
  const registerShortcutGroup = palette?.registerShortcutGroup;
  const isPhone = useMediaQuery(PHONE_QUERY);
  const mod = useModKeyLabel();
  const baseId = useId();
  const sidebarId = `${baseId}-sidebar`;
  const sidebarRef = useRef<HTMLElement>(null);

  const collapsed = useSyncExternalStore(
    subscribeCollapsed,
    () => readCollapsed(storageKey, defaultCollapsed),
    () => defaultCollapsed
  );
  // Re-render after a toggle without waiting for the attribute observer.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tip, setTip] = useState<RailTip | null>(null);
  // Widening past the phone breakpoint closes the drawer (set during
  // render: it is derived from the media query, not an effect's job).
  if (drawerOpen && !isPhone) setDrawerOpen(false);
  const drawerActive = drawerOpen && isPhone;
  const railActive = collapsed && !isPhone;
  const hasTabs = tabs !== undefined && tabs.length > 0;

  // Mirror the choice onto <html>, where the rail CSS reads it (a no-op when
  // the pre-paint script already set it); clear it when the shell unmounts.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.shellCollapsed = readCollapsed(storageKey, defaultCollapsed)
      ? 'true'
      : 'false';
    return () => {
      delete root.dataset.shellCollapsed;
    };
  }, [storageKey, defaultCollapsed]);

  const toggleCollapsed = useCallback(() => {
    const next = !readCollapsed(storageKey, defaultCollapsed);
    document.documentElement.dataset.shellCollapsed = next ? 'true' : 'false';
    if (storageKey !== undefined) writeStorage(storageKey, next ? '1' : '0');
    setTip(null);
    rerender();
  }, [storageKey, defaultCollapsed]);

  // "[" toggles the rail on desktop, never while typing or under a modal.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.key !== '[') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target) || modalIsOpen()) return;
      if (
        typeof window.matchMedia === 'function' &&
        window.matchMedia(PHONE_QUERY).matches
      ) {
        return;
      }
      event.preventDefault();
      toggleCollapsed();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleCollapsed]);

  // List "[" in the palette's shortcuts sheet while the shell is mounted,
  // except on a phone, where the key does nothing (there is no rail).
  useEffect(() => {
    if (isPhone) return undefined;
    return registerShortcutGroup?.({
      title: 'Sidebar',
      rows: [{ label: 'Collapse or expand the sidebar', keys: ['['] }],
    });
  }, [registerShortcutGroup, isPhone]);

  // Phone drawer: a modal dialog while open.
  useDialogFocus(sidebarRef, drawerActive);
  useScrollLock(drawerActive);
  useEffect(() => {
    if (!drawerActive) return undefined;
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setDrawerOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerActive]);

  /** Shows the rail tooltip beside the hovered or focused row. */
  function showTip(target: EventTarget): void {
    if (!railActive || !(target instanceof Element)) return;
    const host = target.closest<HTMLElement>('[data-tip]');
    if (host === null) {
      setTip(null);
      return;
    }
    const rect = host.getBoundingClientRect();
    const next = {
      label: host.dataset.tip ?? '',
      top: Math.round(rect.top + rect.height / 2),
    };
    setTip((prev) =>
      prev !== null && prev.label === next.label && prev.top === next.top
        ? prev
        : next
    );
  }

  const settingsLabel = settings?.label ?? 'Settings';
  const signOutLabel = signOut?.label ?? 'Sign out';
  const collapseLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar';

  return (
    <div
      className={styles.shell}
      data-drawer={drawerOpen ? 'open' : 'closed'}
      data-shell-tabbar={hasTabs ? 'true' : undefined}
    >
      <Link href={`#${mainId}`} className="skipLink">
        Skip to content
      </Link>

      <aside
        ref={sidebarRef}
        id={sidebarId}
        className={styles.sidebar}
        aria-label="Sidebar"
        role={drawerActive ? 'dialog' : undefined}
        aria-modal={drawerActive ? 'true' : undefined}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (drawerActive && sidebarRef.current !== null) {
            trapTab(event, sidebarRef.current);
          }
        }}
        onClick={(event) => {
          // Following a link from the phone drawer closes it.
          if (
            drawerOpen &&
            event.target instanceof Element &&
            event.target.closest('a') !== null
          ) {
            setDrawerOpen(false);
          }
        }}
        onMouseOver={(event) => showTip(event.target)}
        onMouseLeave={() => setTip(null)}
        onFocus={(event) => showTip(event.target)}
        onBlur={() => setTip(null)}
      >
        {/* Registration marks where the sidebar's right hairline crosses
            the topbar line and the footer line: 11px crossed 1px arms
            centred on the border, as on the Analytics nav. */}
        <span className={cx(styles.mark, styles.markTop)} aria-hidden="true" />

        <div className={styles.brand}>
          <Link href={brandHref} className={styles.brandLink}>
            <span className={styles.appName}>{appName}</span>
            {workspaceName !== undefined && workspaceName !== '' ? (
              <span className={styles.workspace}>{workspaceName}</span>
            ) : null}
          </Link>
          <span className={styles.collapseWrap} data-tip={collapseLabel}>
            <button
              type="button"
              className={cx(styles.squareButton, styles.collapseButton)}
              aria-label={collapseLabel}
              aria-keyshortcuts="["
              title={railActive ? undefined : `${collapseLabel} ( [ )`}
              onClick={toggleCollapsed}
            >
              {collapsed ? (
                <PanelLeftOpen size={15} strokeWidth={1.5} aria-hidden="true" />
              ) : (
                <PanelLeftClose
                  size={15}
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
              )}
            </button>
          </span>
          <button
            type="button"
            className={cx(styles.squareButton, styles.closeButton)}
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
          >
            <X size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>

        <div className={styles.scroll}>
          <nav aria-label="Primary">
            <ul className={styles.list}>
              {nav.map((item) => (
                <NavRow key={item.id} item={item} />
              ))}
            </ul>
          </nav>
          {sections.map((section) => (
            <SectionList
              key={section.id}
              section={section}
              headingId={`${baseId}-section-${section.id}`}
            />
          ))}
        </div>

        <div className={styles.footer}>
          <span
            className={cx(styles.mark, styles.markBottom)}
            aria-hidden="true"
          />
          {footer}
          {settings !== undefined ? (
            <ul className={styles.list}>
              <li data-tip={settingsLabel}>
                <Link
                  href={settings.href}
                  className={styles.item}
                  aria-current={settings.current === true ? 'page' : undefined}
                >
                  <span className={styles.icon}>
                    <Settings size={16} strokeWidth={1.5} aria-hidden="true" />
                  </span>
                  <span className={styles.label}>{settingsLabel}</span>
                </Link>
              </li>
            </ul>
          ) : null}
          {user !== undefined ||
          themeStorageKey !== undefined ||
          signOut !== undefined ? (
            <div className={styles.userRow}>
              {user !== undefined ? <UserBlock user={user} /> : null}
              <div className={styles.tools}>
                {themeStorageKey !== undefined ? (
                  <span data-tip="Switch theme" className={styles.toolWrap}>
                    <ThemeToggle storageKey={themeStorageKey} />
                  </span>
                ) : null}
                {signOut !== undefined ? (
                  <form
                    action={signOut.action}
                    method={signOut.method}
                    className={styles.signOut}
                    data-tip={signOutLabel}
                  >
                    <button
                      type="submit"
                      className={styles.squareButton}
                      aria-label={signOutLabel}
                      title={railActive ? undefined : signOutLabel}
                    >
                      <LogOut size={14} strokeWidth={1.5} aria-hidden="true" />
                    </button>
                  </form>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </aside>

      <div
        className={styles.scrim}
        aria-hidden="true"
        onClick={() => setDrawerOpen(false)}
      />

      <div className={styles.column}>
        <header className={styles.topbar}>
          <button
            type="button"
            className={cx(styles.squareButton, styles.menuButton)}
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls={sidebarId}
            onClick={() => setDrawerOpen(true)}
          >
            <Menu size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
          {crumbs.length > 0 ? (
            <nav aria-label="Breadcrumb" className={styles.crumbs}>
              <ol className={styles.crumbList}>
                {crumbs.map((crumb, i) => {
                  const last = i === crumbs.length - 1;
                  return (
                    <li key={`${i}-${crumb.label}`} className={styles.crumb}>
                      {i > 0 ? (
                        <span className={styles.sep} aria-hidden="true">
                          ›
                        </span>
                      ) : null}
                      {crumb.href !== undefined && !last ? (
                        <Link href={crumb.href} className={styles.crumbLink}>
                          {crumb.label}
                        </Link>
                      ) : (
                        <span
                          className={styles.crumbCurrent}
                          aria-current={last ? 'page' : undefined}
                        >
                          {crumb.label}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
            </nav>
          ) : null}
          <span className={styles.spacer} />
          {openSearch !== undefined ? (
            <button
              type="button"
              className={styles.search}
              aria-label={`${searchLabel} (${mod} K)`}
              aria-keyshortcuts="Control+K Meta+K"
              onClick={openSearch}
            >
              <Search size={14} strokeWidth={1.5} aria-hidden="true" />
              <span className={styles.searchLabel}>{searchLabel}</span>
              <KbdKeys keys={[mod, 'K']} className={styles.searchKeys} />
            </button>
          ) : null}
          {topbarActions !== undefined && topbarActions !== null ? (
            <div className={styles.topbarActions}>{topbarActions}</div>
          ) : null}
        </header>

        <main id={mainId} tabIndex={-1} className={styles.main}>
          {banner !== undefined && banner !== null ? (
            <div className={styles.banner}>{banner}</div>
          ) : null}
          {children}
        </main>
      </div>

      {hasTabs ? (
        <nav className={styles.tabbar} aria-label="Sections">
          <ul
            className={styles.tabList}
            style={{ '--tab-count': tabs.length + 1 } as CSSProperties}
          >
            {tabs.map((tab) => (
              <li key={tab.id}>
                <Link
                  href={tab.href}
                  className={styles.tab}
                  aria-current={tab.current === true ? 'page' : undefined}
                >
                  <span className={styles.tabIcon}>{renderIcon(tab.icon)}</span>
                  <span className={styles.tabLabel}>{tab.label}</span>
                </Link>
              </li>
            ))}
            <li>
              <button
                type="button"
                className={styles.tab}
                aria-expanded={drawerOpen}
                aria-controls={sidebarId}
                onClick={() => setDrawerOpen(true)}
              >
                <span className={styles.tabIcon}>
                  <Ellipsis size={16} strokeWidth={1.5} aria-hidden="true" />
                </span>
                <span className={styles.tabLabel}>{moreLabel}</span>
              </button>
            </li>
          </ul>
        </nav>
      ) : null}

      {railActive && tip !== null ? (
        <div className={styles.tip} style={{ top: tip.top }} aria-hidden="true">
          {tip.label}
        </div>
      ) : null}
    </div>
  );
}
