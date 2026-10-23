# @better-tracker/ui

React components for the Milestone Planner's task UI: Gr8r Studio layout
(sidebar shell, command palette, grouped task lists, Gantt timeline, slide-over
drawer) in the Analytics `competitors-site` visual language (paper and ink, one
purple accent `#9747ff`, 1px hairlines, mono labels, no radius, no shadows). The
planner (Next.js) uses it today; it is written to be adopted by the Dispatch
desktop app (Vite + Tauri) as well.

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

`styles.css` holds the design tokens (`--paper`, `--ink`, `--background`,
`--foreground`, `--border`, `--muted`, `--accent`, `--accent-hover`,
`--on-accent`, `--accent-ink`, `--accent-ink-hover`, `--accent-ink-inverse`,
`--ink-soft`, `--grey-2..4`, `--grey-2-ink`, `--hairline-faint`, `--hatch`,
`--tint`, the `*-inverse` set, the status hues `--red`, `--amber`, `--green`,
`--blue`, `--grey` with their `-ink`, `-ink-inverse` and `--on-*` steps,
`--font-sans`, `--font-mono`, the easing curves), the `data-tone` hook, a small
reset, and the shared classes the components use by name (`.block`, `.blockBar`,
`.blockKey`, `.blockTitle`, `.blockMeta`, `.srOnly`, `.skipLink`, `.page`,
`.key`, `.label`, `.muted`, `.mono`, `.accentLink`, `.button`, `.buttonPrimary`,
`.input`, `.select`, `.textarea`, `.notice`, `.hatched`, `.empty`). Everything
else is in CSS modules.

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
(`button { padding: 0; background: none; border-radius: 0 }`,
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
it. The wrapper also takes the paper colour, ink and body font. The host's
`:root` tokens, `<body>` and its own elements are untouched. Caveats:

- Host content passed into a component (a `ReactNode` prop such as
  `titleControl`, `sectionMeta`, `toolbarEnd`) renders inside the wrapper, so it
  sees this package's tokens and reset. Pass controls from this package there,
  or expect to restyle them.
- Popovers (`PickerPopover` and the pickers) use the browser's top layer but
  stay DOM children of the wrapper, so they keep its tokens. Nothing is
  portalled to `<body>`.

Colour jobs: `--accent` is the purple for fills, marks, rules and outlines (one
value in both themes). Purple **text** uses `--accent-ink` (a lighter purple in
dark, where `#9747ff` is only 4.25:1 on the paper), `--accent-ink-hover` when
hovered or focused, and `--accent-ink-inverse` on a `--foreground` hover flood;
dim grey text uses `--grey-2-ink` (`--grey-2` is 3.2:1 on white, so it stays for
separators, furniture and disabled controls). The purple never means a status.

Status has its own hues (see "Status vocabulary"): `--red`, `--amber`,
`--green`, `--blue` and `--grey` are MARK colours (fills, outlines, bars,
glyphs; 3:1 on the paper, the tint, the chrome's hatch line and a flood's ink,
so they never swap in an ink flood; inside a purple flood that retints the ink
to `--on-accent`, such as the sidebar item hover or the accent `Chip`, the block
also turns `--red`, `--amber`, `--green` and `--grey` to `--on-accent`, since no
hue holds 3:1 on the purple; dark `--green` steps lighter to `#1c9444` so a 1px
on-track edge holds 4.9:1 on the black paper, and ink rather than white sits on
its fill), `--red-ink`, `--amber-ink`, `--green-ink` and `--blue-ink` are their
TEXT colours (4.5:1), `--<hue>-ink-inverse` the text on an ink flood, and
`--on-<hue>` the text on a fill. Rather than naming a hue, a component puts
`data-tone` on the element and uses the hook's `--tone` (mark), `--tone-ink`
(text) and `--on-tone`, which `tokens.css` defines for every `UiTone`.

A component that floods a row with ink swaps the text tokens along with
`--background` and `--foreground` (`test/styles-contrast.test.ts` checks every
such block):

```css
.row:hover {
  --background: var(--ink);
  --foreground: var(--paper);
  --accent-ink: var(--accent-ink-inverse);
  --accent-ink-hover: var(--accent-ink-inverse);
  --red-ink: var(--red-ink-inverse);
  --amber-ink: var(--amber-ink-inverse);
  --green-ink: var(--green-ink-inverse);
  --blue-ink: var(--blue-ink-inverse);
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
`--font-mono` is `var(--font-jetbrains, 'JetBrains Mono')` then Fira Code, Menlo
and other monospace fonts. The planner sets `--font-geist` and
`--font-jetbrains` with `next/font`; another host either sets those two
variables or loads the families under those names (for example with
`@fontsource`). The components use sans at weights 300–600 and mono at 400–700.

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

Status keeps the system's square marks and colours them with the status hues
(owner decision 2026-10-22; the full table is in `docs/architecture.md` §8.2
"Status colours"). The shape always differs too, and the label is always there
for assistive tech, so colour is never the only cue:

| `UiStatus` | mark                                                     |
| ---------- | -------------------------------------------------------- |
| `done`     | filled ink square (never green: see below)               |
| `on_track` | hollow square, 1px green edge                            |
| `at_risk`  | hollow square, 2px amber edge                            |
| `overdue`  | filled red square                                        |
| `missing`  | hatched grey square (an input is missing)                |
| `open`     | hollow square, 1px ink edge (no status claim of its own) |
| `muted`    | prop on `StatusMark`: hollow, `--grey` edge, any status  |

Done and overdue share the filled square, so they differ in lightness as well as
hue: done stays ink, because a green fill is as light as the red one and the two
would look the same without red-green vision or in greyscale. Green is the
on-track edge and done's words.

The other shared vocabularies:

- `UiTone`: `default` (ink), `muted` (grey: inactive, nothing to do), `accent`
  (the purple: new, unread, selected; never a status) and the `SemanticTone`s
  `danger` (red: overdue, failed, urgent), `warning` (amber: at risk, blocked,
  unassigned, a missing input), `success` (green: on track, done's words,
  succeeded) and `info` (blue: in progress, running). Components emit it as
  `data-tone`. `Chip`, `Notice`, `AlertStrip` (default `warning`: an alert is
  always a status, never the purple), `ProgressRule`, `RegisterRow` (a 2px left
  rule), `RegisterCell` (the value only; the mono `sub` line under it stays
  muted unless `toneSub` opts it in, for a reason line that is the point: a
  blocked project's reason, a failed sync's error) and `StatsStrip` draw every
  tone; `Button variant="danger"` is red. `Checklist` (the rubric) keeps a met
  item the filled ink square, like done, so a missing item's hollow amber square
  and "Missing" are the only hue in the list.
- `TaskStateKind` (Linear's state types): `triage`, `backlog`, `unstarted`,
  `started`, `completed`, `canceled`, drawn by `StateGlyph` (in progress blue,
  done green, triage / backlog / canceled grey, todo ink).
- `TaskPriority`: `0` none, `1` urgent, `2` high, `3` medium, `4` low, drawn by
  `PriorityGlyph` (urgent in red).
- `ChipTone`: any `UiTone` (a status tone is the ink chip's outline and text in
  the hue; with `filled` a slab of the hue with its `--on-<hue>` text, for the
  chips that were filled before the status hues), or `inverse`.
- `ShellNavItem.countTone`: `accent` (new, unread) or a status tone (e.g.
  `warning` for blocked projects) turns the count into a square chip in that
  colour.
- Graph: `GraphNodeTone` (any `UiTone`: `danger` / `warning` / `success` /
  `info` draw a 2px rule in the hue, `muted` a faint box: a done one keeps its
  filled ink done square, any other status mark turns `--grey` (shape kept; a
  missing input stays hatched), `accent` a purple rule for a host's own
  emphasis, never a status), `GraphNodeTag` (`UNASSIGNED` a filled amber chip,
  inverted on the red flood; `OVERDUE` floods the box red, `CYCLE` a dashed red
  outline, or any string), `GraphEdgeKind` (`default`, `risk` amber, `cycle`
  dashed red, `cross`, `resolved`). `GraphLegendMark` adds `node-warning` (the
  amber rule), the Status highlight's `node-ready` (1px green edge),
  `node-blocked` (2px amber) and `node-stuck` (2px red), the Critical path's
  `node-chain` (ink ring and step) and `node-faded`, the edges `edge-unblocked`
  (green dots) and `edge-chain` (2.5px ink), the Paths row's `path-active` (the
  accent flood of the box being read), `path-up` (accent ring), `path-down` (ink
  ring), `path-next` (the square "Ready next" tag) and `path-chain` (as
  `node-chain`), and the frames `cluster` and `cluster-muted`.
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
|          | `BlockBar` (hatched block titlebar)                                                                                    | `index`, `title`                                                   |
|          | `Tabs` (ids are prefixed per instance; `label` names the tablist; empty renders nothing)                               | `items: TabItem[]` (`id`, `label`, `content`)                      |
|          | `ThemeToggle`                                                                                                          | `storageKey`                                                       |
| tasks    | `Button`                                                                                                               | none (`href` renders a link)                                       |
|          | `Checkbox`, `Switch`, `SegmentedControl`, `Chip`                                                                       | see `tasks/types.ts`                                               |
|          | `TaskGroupTable` (grouped issue list)                                                                                  | `sections`                                                         |
|          | `DeadlineList`, `StatsStrip`, `ProgressRule`                                                                           | `groups`; `cells`; `done`/`total`                                  |
|          | `Register`, `RegisterRow`, `RegisterCell`                                                                              | `columns`, `label`, `children`                                     |
|          | `Notice`, `EmptyState` (optional mono `label` above the sentence), `NavTabs`, `Checklist`                              | see `tasks/types.ts`                                               |
| shell    | `AppShell` (sidebar, topbar, phone tab bar)                                                                            | `appName`, `brandHref`, `nav`                                      |
|          | `CommandPaletteProvider` + `CommandPalette`                                                                            | none; pass `navigate` (the default is `window.location.assign`)    |
|          | `ToastProvider` + `useToast()`                                                                                         | none                                                               |
|          | `SlideOver` (`contentKey` names what it shows: a new key while open moves focus to the panel)                          | `open`, `onClose`, `title`                                         |
|          | `SignedOutFrame`, `PropertyList`, `AlertStrip`                                                                         | see `shell/types.ts`                                               |
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
graph's path walks (`pathContext`, `nodePaths`, `longestChains`, `longestChain`,
`describePaths`, …), the palette's `fuzzyMatch`, and the collapsed-group storage
helpers.

### Graph and timeline options

- `DependencyGraph` `layout`: a `GraphLayout` the host computed with
  `layoutGraph` from the same `nodes`, `edges` and options. It is used as is, so
  a server render can lay the graph out once and the client (a phone included)
  never runs dagre; `direction`, `cluster` and the layout of `clusters` are then
  ignored (pass the same `clusters` anyway: the names use them). `layoutGraph`
  is pure and carries no `'use client'`, so it runs on a server.
- `DependencyGraph` `clusters` (and `layoutGraph`'s `clusters` option): a graph
  of every item, framed by parent. Each `GraphClusterData` (`id`, `label`,
  `parent`, `muted`, `external`) is a labelled frame, nested through `parent`;
  `GraphNodeData.cluster` names a node's innermost frame (unknown or none: the
  top level). Inside each frame the nodes and frames on an arrow flow along the
  direction by dagre, over that frame's own items only, with the ends of arrows
  that leave it drifting to its far side; the nodes on no arrow pack into a
  compact grid under the flow (done and empty ones last; two or more nodes get
  at least two columns), and frames on no arrow onto shelves under that. When
  frames in a flow would chain into a row longer than `CLUSTER_METRICS.flowMax`
  (2400px, or 1.25 times their shelf width), they go onto shelves in flow order
  instead and their arrows are drawn without a dagre route; when the flow's
  longest chain alone (`flowChain`, a lower bound on dagre's own acyclic graph)
  already passes that, dagre is not run for it at all. dagre's edge weights are
  whole numbers: a fractional one can leave network-simplex pivoting forever.
  Arrows between frames leave the blocker's far side and enter the waiting box's
  near side, following dagre's lane to the far side of each frame they leave and
  from the near side of each they enter (in a flow small enough for
  network-simplex the frame's ports rank after and before its whole flow; in a
  bigger one they sit beside their own items, to keep its cost down), so they
  pass the other boxes there instead of running behind them; arrows inside one
  frame keep their dagre route. Top to bottom, a frame's grid sits under its
  flow, in the way of the arrows leaving it, so frames read best left to right
  (every host uses `LR`). Given at all, even empty, `clusters` also packs the
  loose top-level nodes, so a host with no frames for a level (the planner's
  initiative level) still gets no long column. Frames are drawn decoratively
  (`data-graph-cluster`, `data-depth`, `data-muted`, `data-external`): a 1px
  `--grey-2` hairline, a mono caps title in the top-left on a paper patch above
  the arrows (ink at the top level, `--muted` nested), hatched with a `--grey`
  rule when muted, dashed when external; each node's accessible name says the
  frames it sits in ("in Beta, Orion"). The layout carries `clustered: true`;
  its nodes come in reading order (frame by frame) and the arrow keys move to
  the nearest box that way. The legend draws frames as `cluster` and
  `cluster-muted`. Flows of more than `CLUSTER_METRICS.simplexItems` items or
  `simplexLinks` links rank with dagre's tight-tree instead of network-simplex,
  which keeps one big, dense frame near 0.5 s for 500 nodes and 800 edges
  (network-simplex: about 5 s).
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
- `DependencyGraph` `highlight`: what the drawing emphasises. `risk` (the
  default, so a host that passes nothing keeps its look) draws the risk tones:
  the red overdue flood, the 2px rule in a node's `tone`, amber risk chains.
  `status` tones each node by its readiness instead: a 1px green edge when
  ready, the 2px amber rule when blocked, red when stuck, faint when done (its
  filled ink done square kept), empty or paused (its mark in `--grey`), and
  unblocked edges as green dots. `critical` numbers the critical path and lets
  the rest recede. Switching never moves a box: the layout ignores the
  highlight, so one `layout` serves all three. The frame carries
  `data-highlight`; nodes carry `data-state` (`active`, `lit`, `down`, `chain`,
  `dim`), `data-pointed` (the box being read), `data-readiness`, `data-next` and
  `data-step`.
- `GraphNodeData.readiness` (`GraphNodeReadiness`: `state` ready, blocked, done,
  independent or empty (a box nothing counts toward, walked like done but read
  as its `statusLabel` or "No issues", never "Done"); the chip `label`, "Ready",
  "Blocked by 2", "Clear", `''` when done or empty; an independent node (on no
  relation at all) has the word "No dependencies" in its name and readout but no
  chip, and draws neutral; the Status `tone`; `blockedBy`; `unblocks`;
  `canStart`). Count `blockedBy` (open blockers) and `unblocks` (what finishing
  it alone frees) over all of your data, not only what is drawn: the readout
  says the difference is "not drawn". Set `canStart: false` on a box whose open
  work all waits inside it, so "start with" never points at it. The readiness
  chip leads a node's chips in every highlight (toned only under Status), so
  measure with `measureNode` or `layoutGraph` from the same data. Without
  `readiness` the Status highlight falls back to `tone` and the walks to the
  drawn edges. `GraphNodeData.key` (an id such as "ENG-23") is how the readout
  names a node; else its label.
- Edges: the `resolved` kind means one end is done (the blocker, or the node
  that waited), so it no longer blocks; it is drawn as dots and never walked.
  `GraphEdgeData.cross` marks an edge that crosses a project (or owner) boundary
  whatever its kind; Status and Critical path dash it while it blocks and is not
  a cycle.
- Paths: hover, keyboard focus, a touch tap or the selection lights what the
  node transitively waits on (an accent ring and accent lines) and what waits on
  it (an ink ring and ink lines), over the drawn edges; a `pathWords.next` tag
  ("Ready next", a square mono tag on the box's top rule) marks each node that
  finishing it alone would unblock. The node being read (hover, keyboard focus,
  a touch pin; not the selection) is flooded in the accent on every input, with
  a 4px double `CanvasText` outline in forced colours (the selected node gets
  one too, its ink fill being dropped there). Receding nodes grey their words
  directly and nothing but the flood and the rings fades, so a hover stays cheap
  on hundreds of nodes. Accessible names give the same counts ("waits on 1,
  holds up 3; done would unblock 2"; "waits on 1, holds up 0 in this graph; done
  would unblock 1 (1 not drawn)" when your readiness counts more than is drawn),
  transitive while `V × (V + E)` stays within `PATH_NAME_BUDGET` (V counting
  only the nodes on a blocking edge, so a graph of every item with few arrows
  stays transitive) and direct above it, so a host with no draw limit never runs
  a quadratic walk in render.
- The critical path is the longest chain of blocking drawn edges, a cycle
  counted as one step weighing its member count, ties going to display order;
  with a node active, the longest chain through it; in a chain graph at rest,
  the one through `focusId`. It is computed in O(V + E) per edge list, shown
  only when it holds two or more nodes, and its names carry "step k of s on the
  critical path".
- `DependencyGraph` `readout`: one plain (not live) line under the frame names
  the node being read and its paths ("ENG-23 · Blocked by 1 · Waits on 1 open,
  start with ENG-12 · Holds up 1 · Done would unblock 1: OPS-20"); with nothing
  active it shows this text (your summary for the highlight) and how to trace a
  node (`hint` / `tapHint`, or `hintCritical` / `tapHintCritical` under Critical
  path: "show the longest chain through it"). With nothing drawn waiting on the
  node it says "Nothing here waits on it" (`holdsUpNone`). `null` hides the
  line. `pathWords` (`Partial<GraphPathWords>`, defaults in
  `defaultGraphPathWords`) rewords any part, the tag included.
- Touch: on a touch press (`pointerType === 'touch'`) the first tap traces a
  node and a second tap opens it (`onSelect`, or its link); on a node that opens
  nothing a second tap drops the pin again. A tap on the background or Escape
  drops the pin and its trace (the focus a tap gives a button in Chromium never
  traces on its own). Mouse, pen, keyboard and assistive-tech activation open at
  once.
- **Cap what you draw.** Without `clusters` one layout costs about 0.45 s at 200
  nodes and 300 edges (dagre network-simplex; edges dominate) and grows fast
  past that (about 1.3 s at 400 and 600). With `clusters` (measured 2026-10-23
  after the review fixes on workspace-shaped graphs: frames per project and
  milestone, a fifth of the issues done) the layout alone is about 0.1 s at 200
  and 300, 0.3 s at 500 and 800 and 0.35–0.75 s at 700 and 1000 whatever the
  shape, from one milestone holding everything (0.64 s) to 140 projects; a hover
  at 700 nodes still costs about a tenth of a second of frames on a slow
  machine. Decide a limit in the host and offer a narrower graph instead of
  drawing a bigger one, or part of one.
- `TimelineGroup.link` (`TimelineGroupLink`: `label`, `href`, optional
  `ariaLabel`): a quiet mono link with a group's "N projects", rendered through
  the host `<Link>`: in the chart's group row it sits under the count, in one
  right-aligned column, so the group name keeps its width; in the phone card's
  group head it follows the count, and the name ellipsizes before it gives way.
  Pass `ariaLabel` when several groups share the label ("Dependency graph of
  Payments platform").

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
