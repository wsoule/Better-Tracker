# @better-tracker/ui

React components for the Milestone Planner's task UI in Gr8r Studio's layout and
look (sidebar shell, command palette, grouped task lists, Gantt timeline,
slide-over drawer; warm neutral surfaces, soft borders, radius, soft shadows on
floating things, tinted semantic status colours, sentence-case Geist), with one
purple accent `#9747ff` for primary actions, focus, selection and progress
(`docs/architecture.md` §8.2 has the rules). The planner (Next.js) uses it
today; it is written to be adopted by the Dispatch desktop app (Vite + Tauri) as
well.

The package has no framework or domain coupling: no `next/*`, no
`@better-tracker/*` imports, no `process.env`, and no `window`/`document` read
during render. Every prop is plain data plus callbacks, and links render through
a component the host injects.

## What a host needs

- **React 19.2** (`react` and `react-dom` are peer dependencies).
- **A bundler that compiles TypeScript source and CSS modules.** There is no
  `dist`: `exports` points at `src/index.ts`, and component styles are
  `*.module.css` files next to each component. Next needs
  `transpilePackages: ['@better-tracker/ui']`; Vite handles both natively. The
  `'use client'` directives are for Next and are ignored elsewhere.
- **Runtime dependencies** `lucide-react` (icons) and `@dagrejs/dagre` (graph
  layout), installed with the package.
- **TypeScript.** The host type-checks this source with its own compiler and
  flags. It passes TypeScript 5.9 with Dispatch's `apps/desktop` settings (not
  strict, so `strictNullChecks` is off; `lib: ["ES2023", "DOM"]` without
  `DOM.Iterable`, `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`,
  `verbatimModuleSyntax`) and with strict on. Keep it that way: narrow unions
  with a type guard rather than `x !== undefined` (which does not narrow without
  `strictNullChecks`), iterate a `NodeList` through `Array.from`, prefix unused
  parameters with `_`. The `typecheck-host` task (`tsconfig.host.json`) checks
  the non-strict side; TypeScript 7 folds `DOM.Iterable` into `DOM`, so the
  `Array.from` rule is checked by review only.

## Installing from another repository

The package is not on a registry (it is `private`). Another repository, such as
Dispatch, installs it from a tarball made in a Better-Tracker checkout:

```bash
# in Better-Tracker, after `pnpm install`
cd packages/ui
pnpm pack --pack-destination /path/to/dispatch/vendor
# writes better-tracker-ui-<version>.tgz there
```

```bash
# in Dispatch (apps/desktop, or wherever the UI lives)
pnpm add ./vendor/better-tracker-ui-0.0.0.tgz
```

`pnpm pack` writes the `catalog:` versions of `lucide-react` and
`@dagrejs/dagre` into the tarball's `package.json` as exact versions, and ships
only `src/`, `global.d.ts` and this README (`files`). The host's own `react` and
`react-dom` satisfy the peer dependencies, so there is one React and Vite needs
no `resolve.dedupe`. Commit the tarball (or keep it next to the lockfile) so
installs are reproducible, and raise `version` in `package.json` when you pack a
new one, so the file name and lockfile entry change with it. This was verified
by installing the tarball into a fresh project outside this repository with pnpm
and type-checking a page that imports `TaskDetail`, `TimelineChart`,
`StatusMark`, `UiLinkProvider`, `themeScript` and `styles.css` with TypeScript
5.9 under Dispatch's `apps/desktop` flags (strict and not strict), then building
it with Vite 8. `test/package-manifest.test.ts` keeps the manifest packable.

A `file:` or git dependency on the `packages/ui` directory does not work: pnpm
resolves `catalog:` only inside the workspace that defines it
(`ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER @dagrejs/dagre@catalog:`). For
working on both repositories at once,
`pnpm add link:/path/to/better-tracker/packages/ui` links the live source
instead (with this repository's dependencies installed). A linked package
resolves `react` from Better-Tracker's `node_modules`, so Vite then needs:

```ts
// vite.config.ts
export default defineConfig({
  resolve: {
    // One React: the linked files would otherwise resolve react from
    // their own node_modules.
    dedupe: ['react', 'react-dom'],
  },
  server: { fs: { allow: ['..', '/path/to/better-tracker/packages/ui'] } },
});
```

TypeScript needs a declaration for `*.module.css` and `*.css` imports. Vite's
`vite/client` types provide it; another host can include the package's
`global.d.ts`.

## Styles

Import the global sheet once, **after** the host's own global CSS so the
package's focus ring and reset win inside its components:

```ts
import './styles/global.css'; // the host's
import '@better-tracker/ui/styles.css';
```

`styles.css` holds the design tokens (surfaces `--bg`, `--bg-side`, `--surface`,
`--surface-2`, `--surface-3`, `--sunken`, `--overlay`; lines `--divider`,
`--border`, `--border-strong`; text `--text` … `--text-4`, `--text-inv`; the
accent `--accent`, `--on-accent`, `--accent-ink`, `--accent-ink-hover`,
`--accent-soft`, `--accent-line`, `--accent-hover`, `--accent-active`; semantic
`--red`, `--amber`, `--green`, `--blue` with their `-soft` and `-line` tints,
`--on-danger`; categorical hues; workflow `--st-*`; `--shadow-*`; `--r-*`;
`--s-*`, `--gutter`; `--font-sans`, `--font-mono`, `--fs-*`, `--fw-*`, `--lh*`,
`--ls-*`; `--h-*` and other sizes; `--ease`, `--spring`, `--ease-drawer`,
`--dur`; plus the pre-Gr8r names `--paper`, `--ink`, `--background`,
`--foreground`, `--muted`, `--grey-*`, `--tint`, `--hairline-faint` … kept as
aliases only for the graph's older drawing, which has not been restyled yet), a
small reset (body, focus ring, selection, scrollbars), the `[data-tone]`
variables (`--tone`, `--tone-ink`, `--tone-soft`, `--tone-line`) and the shared
classes the components use by name (`.block`, `.blockBar`, `.blockKey`,
`.blockTitle`, `.blockMeta`, `.srOnly`, `.skipLink`, `.page`, `.key`, `.label`,
`.eyebrow`, `.muted`, `.faint`, `.mono`, `.num`, `.accentLink`, `.button`,
`.buttonPrimary`, `.input`, `.select`, `.textarea`, `.notice`, `.hatched`,
`.empty`). Everything else is in CSS modules.

### Page mode (default)

With nothing else set, the sheet styles the whole document: tokens on `:root`,
the reset on every element, the shared classes anywhere. That is what the
planner wants (it owns the page).

### Scoped mode (embedding in an app with its own design system)

Page mode would take over a host such as Dispatch: both define `--accent`,
`--accent-hover`, `--background`, `--foreground`, `--border`, `--muted`,
`--font-sans`, `--font-mono` and `--ease-out-expo` on `:root`; Dispatch's
Tailwind `block` utility class would get `.block`'s 1440px max-width, 40px
margin and 48px padding; and the unlayered reset
(`button { padding: 0; background: none; border: 0 }`,
`ul { list-style: none }`, `svg { display: block }`) beats Tailwind's layered
utilities on every host element.

Opt out of page mode with two attributes:

```html
<html data-bt-ui-scoped></html>
```

```tsx
<div data-bt-ui="" data-theme={theme}>
  <TaskDetail {...props} />
</div>
```

With `data-bt-ui-scoped` on `<html>`, the tokens are declared on each
`[data-bt-ui]` element only, and the reset and shared classes apply only inside
it. The wrapper also takes the surface colour, text colour and body font. The
host's `:root` tokens, `<body>` and its own elements are untouched. Caveats:

- Host content passed into a component (a `ReactNode` prop such as
  `titleControl`, `sectionMeta`, `toolbarEnd`) renders inside the wrapper, so it
  sees this package's tokens and reset. Pass controls from this package there,
  or expect to restyle them.
- Popovers (`PickerPopover` and the pickers) use the browser's top layer but
  stay DOM children of the wrapper, so they keep its tokens. Nothing is
  portalled to `<body>`.

Colour jobs: `--accent` is the purple for fills, focus rings and selection (one
value in both themes); it never means a status. Purple **text** uses
`--accent-ink` (darker in light, lighter in dark, so it reads 4.5:1 on every
surface and on `--accent-soft`) and `--accent-ink-hover`. Status and risk use
the semantic hues (`--red`, `--amber`, `--green`, `--blue`), which are text-safe
on every surface and on their own `-soft` tint. Grey text is `--text-2` or
`--text-3`; `--text-4` is for icons and glyphs only. Hover fills are
`--surface-2`, not ink floods. A component that still floods a row with ink (the
old idiom; only the graph's nodes still do, until its restyle) must swap the
text tokens along with `--background` and `--foreground`:

```css
.row:hover {
  --background: var(--ink);
  --foreground: var(--paper);
  --accent-ink: var(--accent-ink-inverse);
  --accent-ink-hover: var(--accent-ink-inverse);
  --grey-2-ink: var(--muted-inverse);
}
```

## Theme

Dark mode is `data-theme="dark"`, on `<html>` (page mode) or on `<html>` or the
wrapper (scoped mode; `data-theme="light"` on a wrapper keeps it light under a
dark `<html>`). `data-theme="system"` (on `<html>` or a wrapper) follows the OS
live through `prefers-color-scheme`, with no script: the simplest choice for a
host like Dispatch that wires its own dark mode to the OS. Without any of these
the UI is light, whatever the OS says.

- `themeScript(storageKey)` returns a parser-blocking script for the first child
  of `<body>`: the saved choice, else the OS preference, written to
  `html[data-theme]` before first paint (no flash).
  - Next: `<script dangerouslySetInnerHTML={{ __html: themeScript(KEY) }} />`,
    with `suppressHydrationWarning` on `<html>` (the script changes its
    attribute before React hydrates).
  - Vite: inline it with a plugin:

    ```ts
    import { themeScript } from '@better-tracker/ui/lib/theme.ts';

    const btTheme = {
      name: 'bt-ui-theme',
      transformIndexHtml: () => [
        {
          tag: 'script',
          children: themeScript('app-theme'),
          injectTo: 'body-prepend' as const,
        },
      ],
    };
    ```

- `<ThemeToggle storageKey={KEY} />` flips `html[data-theme]` and saves the
  choice under the same key. It assumes `themeScript` ran (it toggles from
  whatever `<html>` says; from `system` it switches to the opposite of what the
  OS shows). Its glyph follows the nearest `data-theme` ancestor.
- A host that follows the OS but needs the value in JavaScript can set the
  wrapper's attribute itself:

  ```tsx
  const query = '(prefers-color-scheme: dark)';
  function useOsTheme(): 'light' | 'dark' {
    return useSyncExternalStore(
      (onChange) => {
        const list = window.matchMedia(query);
        list.addEventListener('change', onChange);
        return () => list.removeEventListener('change', onChange);
      },
      () => (window.matchMedia(query).matches ? 'dark' : 'light'),
      () => 'light'
    );
  }
  ```

## Fonts

`--font-sans` is `var(--font-geist, Geist)` then system UI fonts, and
`--font-mono` is `var(--font-geist-mono, 'Geist Mono')` then `ui-monospace`,
Menlo and other monospace fonts. The planner sets `--font-geist` and
`--font-geist-mono` with `next/font`; another host either sets those two
variables or loads the families under those names (for example with
`@fontsource`). The components use Geist at weights 400, 450, 500 and 600 (body
13.5px), and Geist Mono at 400 for issue keys, `kbd` and code only.

## Links

Components never import a router. They render `<Link>` from this package, which
renders the host's component from `UiLinkProvider` (a plain `<a>` when none is
provided). `http://` and `https://` URLs always render as a plain `<a>` (usually
with `target="_blank"`), not through the host's component.

```tsx
import { UiLinkProvider, type UiLinkProps } from '@better-tracker/ui';

function HostLink({ href, onClick, ...rest }: UiLinkProps) {
  return (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        navigate(href); // the host's router
      }}
    />
  );
}

<UiLinkProvider link={HostLink}>{app}</UiLinkProvider>;
```

`UiLinkProps` is `href`, `className`, `children`, `aria-current`, `aria-label`,
`title`, `target`, `rel` and `onClick`. The planner's adapter is
`apps/planner/app/(app)/components/next-ui-link.tsx` (`next/link`, with plain
anchors for `/api/*`).

## Status vocabulary

Status uses Gr8r's shapes in the semantic hues (`docs/architecture.md` §8.2 maps
every planner status):

| `UiStatus` | mark                                           |
| ---------- | ---------------------------------------------- |
| `done`     | green disc with a tick                         |
| `on_track` | green ring                                     |
| `at_risk`  | amber ring, right half filled                  |
| `overdue`  | red disc                                       |
| `missing`  | dashed grey ring (an input is missing)         |
| `muted`    | prop on `StatusMark`: faint grey ring, any one |

The other shared vocabularies:

- `UiTone`: `default` (neutral), `muted` (grey), `accent` (brand: new, unread,
  selected; never a status), or a `SemanticTone`: `danger` (red), `warning`
  (amber), `success` (green), `info` (blue). Components render it as
  `data-tone`, and `[data-tone]` defines `--tone`, `--tone-ink`, `--tone-soft`
  and `--tone-line` for their CSS.
- `TaskStateKind` (Linear's state types): `triage`, `backlog`, `unstarted`,
  `started`, `completed`, `canceled`, drawn by `StateGlyph`.
- `TaskPriority`: `0` none, `1` urgent, `2` high, `3` medium, `4` low, drawn by
  `PriorityGlyph`.
- `ChipTone`: any `UiTone`, or `inverse` (old callers). `Chip` takes `dot` for
  Gr8r's status pill (neutral, a 6px dot in the tone's hue).
- Graph (older drawing, not restyled yet: its `accent` still marks risk):
  `GraphNodeTone` (`default`, `accent`, `muted`), `GraphNodeTag` (`UNASSIGNED`,
  `OVERDUE`, `CYCLE` or any string), `GraphEdgeKind` (`default`, `risk`,
  `cycle`, `cross`, `resolved`).
- `ToastKind`: `info`, `error`.

Every status mark carries a text label for assistive tech (`label` /
`statusLabel` props). Wording is the host's: components that print built-in
words take a `labels` prop (`DEFAULT_TASK_LABELS`, `DEFAULT_EDIT_LABELS`).

## Components

Props are typed in each family's `types.ts` (the basics in their own files) and
exported from the package root (`TaskDetailProps`, `TimelineChartProps`,
`StatusMarkProps`, `BlockBarProps`, `TabsProps`, `ThemeToggleProps`,
`UiLinkProviderProps`, `PickerMarkViewProps`, …). Required props are listed; see
the types for the rest.

| family   | component                                                                                                              | required props                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| basics   | `StatusMark`                                                                                                           | `status`, `label`                                                  |
|          | `BlockBar` (a section's heading row; `index` is ignored)                                                               | `title`                                                            |
|          | `Tabs` (ids are prefixed per instance; `label` names the tablist; empty renders nothing)                               | `items: TabItem[]` (`id`, `label`, `content`)                      |
|          | `ThemeToggle`                                                                                                          | `storageKey`                                                       |
| tasks    | `Button` (`variant`; `size` `sm` 26px / `md` 30px / `lg` 36px; `block` for full width)                                 | none (`href` renders a link)                                       |
|          | `Checkbox`, `Switch` (`aria-label` / `aria-labelledby` when its visible label is shared), `SegmentedControl`, `Chip`   | see `tasks/types.ts`                                               |
|          | `TaskGroupTable` (grouped issue list)                                                                                  | `sections`                                                         |
|          | `DeadlineList`, `StatsStrip`, `ProgressRule`                                                                           | `groups`; `cells`; `done`/`total`                                  |
|          | `Register`, `RegisterRow`, `RegisterCell`                                                                              | `columns`, `label`, `children`                                     |
|          | `Notice` (`tone`), `EmptyState` (optional `label` title above the sentence), `NavTabs`, `Checklist`                    | see `tasks/types.ts`                                               |
| shell    | `AppShell` (sidebar, topbar, phone tab bar)                                                                            | `appName`, `brandHref`, `nav`                                      |
|          | `CommandPaletteProvider` + `CommandPalette`                                                                            | none; pass `navigate` (the default is `window.location.assign`)    |
|          | `ToastProvider` + `useToast()`                                                                                         | none                                                               |
|          | `SlideOver` (`contentKey` names what it shows: a new key while open moves focus to the panel)                          | `open`, `onClose`, `title`                                         |
|          | `SignedOutFrame`, `PropertyList`, `AlertStrip` (`tone`, default `warning`)                                             | see `shell/types.ts`                                               |
|          | `Skeleton*`, `Kbd`, `KbdKeys`                                                                                          | see `shell/types.ts`                                               |
| timeline | `TimelineChart` (Gantt)                                                                                                | `today`, `windowStart`, `windowEnd`, `zoom`, `groups`, `onOpenBar` |
| graph    | `DependencyGraph`                                                                                                      | `nodes`, `edges`, `ariaSummary`, `emptyMessage`                    |
|          | `GraphLegend`, `MermaidSource`                                                                                         | see `graph/types.ts`                                               |
| task     | `TaskDetail` (`layout="drawer"` or `"page"`)                                                                           | `taskKey`, `title`, `status`, `properties`                         |
|          | `TaskSlideOver` (TaskDetail in a SlideOver)                                                                            | the above plus `open`, `onClose`                                   |
|          | `TaskDescription`, `TaskRelationList`, `TaskCommentList`, `TaskActivityList`, `TaskCrumbs`                             | see `task/types.ts`                                                |
| edit     | `StatePicker`, `AssigneePicker`, `PriorityPicker`, `LabelPicker`, `ProjectPicker`, `MilestonePicker`, `EstimatePicker` | the choices (`states`, `people`, …), `value`, `onChange`           |
|          | `PickerPopover` (the generic picker)                                                                                   | see `edit/types.ts`                                                |
|          | `TaskRelationPicker`                                                                                                   | `label`, `search`, `onSelect`                                      |
|          | `InlineTextField`, `TextAreaEditor`                                                                                    | `label`, `onSave` (and `value` for the field)                      |
|          | `DateField`                                                                                                            | `label`, `value`, `onChange`                                       |

Pure helpers are exported too: the timeline's date scale (`createScale`,
`xForDate`, …), the graph layout (`layoutGraph`, `upstreamChain`, …), the
palette's `fuzzyMatch`, and the collapsed-group storage helpers.

### Graph and timeline options

- `DependencyGraph` `layout`: a `GraphLayout` the host computed with
  `layoutGraph` from the same `nodes`, `edges` and options. It is used as is, so
  a server render can lay the graph out once and the client (a phone included)
  never runs dagre; `direction` and `cluster` are then ignored. `layoutGraph` is
  pure and carries no `'use client'`, so it runs on a server.
- `DependencyGraph` `focusId`: the node the graph is about (one issue's chain,
  say). It gets a 2px ink rule inside its box and lights nothing, unlike
  `selectedId`; its accessible name ends with `focusLabel` (default "focus"),
  and Tab lands on it until a node is focused or selected. On the first paint
  the frame (never the page) scrolls so the focus, else the selected node, sits
  in its middle. The legend draws the mark as `node-focus`.
- `DependencyGraph` `coveredRight`: the width of a panel fixed along the
  window's right edge that is open over the graph (pass `SLIDE_OVER_WIDTH` while
  a `SlideOver` the page opened on arrival is open, and nothing once it closes).
  The frame then keeps right padding for the part the panel covers, so the first
  paint brings the focus or selection into the part the panel leaves uncovered,
  even in a drawing narrower than the frame: centred there, or scrolled only as
  far as it takes to show the whole box when that is less, so what it waits on
  (to its left) stays in view. When the panel would leave less than 240px of the
  frame (a phone's full-width sheet) nothing moves.
- **Cap what you draw.** One layout costs about 0.45 s at 200 nodes and 300
  edges (dagre network-simplex; edges dominate) and grows fast past that. Decide
  a limit in the host and offer a narrower graph instead of drawing a bigger
  one, or part of one.
- `TimelineGroup.link` (`TimelineGroupLink`: `label`, `href`, optional
  `ariaLabel`): a quiet sentence-case link (a ghost button's look) after a
  group's "N projects", rendered through the host `<Link>`: in the chart's group
  row and in the phone card's group head it sits at the right edge, after the
  count that stays beside the name, and the name ellipsizes before it gives way
  (the chart's name keeps its full text as a tooltip). Pass `ariaLabel` when
  several groups share the label ("Dependency graph of Payments platform").

### Edit controls

Every edit control is controlled and saves through one contract: `onChange` /
`onSave` / `onSelect` may return a promise. While it is pending the control
shows the new value with a "Saving" note; when it resolves the value stays; when
it rejects the control rolls back and prints the error beside itself
(`formatError` turns the rejection into that sentence, `saveErrorMessage` is the
default). Returning nothing means "saved".

## Browser behaviour hosts should know about

All of it runs in effects and event handlers on the client; server rendering
touches none of it.

- `ThemeToggle` writes `html[data-theme]` and `localStorage`.
- `AppShell` writes `html[data-shell-collapsed]` (and removes it on unmount),
  binds `[` to collapse the sidebar, and locks `<html>` scrolling while the
  phone drawer is open. `sidebarCollapseScript(key)` is its pre-paint script.
- `CommandPaletteProvider` binds Ctrl/⌘ K, `?` and two-key `G …` shortcuts on
  `document`. Do not mount it in a host that has its own command palette.
- `SlideOver` closes on Esc and traps focus; `TaskGroupTable` can persist folded
  groups in `localStorage` or `sessionStorage` (`storage="session"` suits a
  desktop app). Storage failures are tolerated everywhere.

## Server rendering

Every component renders with `react-dom/server` and no DOM
(`test/*-ssr.test.tsx` run render entries in a child process without happy-dom).
Media queries, storage and the platform's modifier key are read through
`useSyncExternalStore` with server snapshots, so hydration matches.

## Checks

```bash
cd packages/ui
tsc --noEmit --pretty   # includes noUnusedParameters + erasableSyntaxOnly
tsc -p tsconfig.host.json --noEmit   # ui:typecheck-host: not strict, as a host
bun test                # includes test/styles-scope.test.ts: every selector
                        # in the global sheet must be scopable, and the
                        # system theme must equal the dark one
```

The `/ui-gallery` pages of the planner (demo mode) render every family with
fixture props.
