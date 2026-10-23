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
- `ToastKind`: `info`, `error`. A `ToastInput` may carry `announce` (what the
  live region says in place of the visible sentence) and `onClose` (called once
  when the toast leaves the stack, however it goes).

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
|          | `Checkbox` (`indeterminate` for a partly selected group), `Switch`, `SegmentedControl`, `Chip`                         | see `tasks/types.ts`                                               |
|          | `TaskGroupTable` (grouped issue list; selection, drag and slots below)                                                 | `sections`                                                         |
|          | `ViewToolbar` (list toolbar: search, the host's Filter / Sort / Group, end actions), `ToolbarBadge`                    | `search`, `controls`                                               |
|          | `FilterChips` ("PROJECT is …" chips joined by "and", + Filter, Clear all)                                              | `chips`                                                            |
|          | `BulkBar` (the floating bar of a selection; confirm strip, busy, note), `useBulkBarHeight()` (its height while up)     | `count`, `onClear`, `children`                                     |
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
`describePaths`, …), the palette's `fuzzyMatch`, the collapsed-group storage
helpers, and the selection helpers (`toggleId`, `rangeIds`, `setIds`,
`pruneSelection`: pure, never mutating, and returning the same set when nothing
changes).

### Lists: selection, drag, slots, toolbar, chips, bulk bar

`TaskGroupTable` takes optional props for a list people act on (the planner's
Issues page). With none of them it renders exactly what it rendered before (a
DOM snapshot of My week's props guards that). Its groups and rows are memoized,
so a selection, a fold or a host render redraws only the rows it touches: the
event callbacks (`onOpenRow`, `onOpenGroup`, `onRowContextMenu`, `selection`'s
`onChange`, `drag`'s) are read when they run and may change every render, but
the render slots (`renderCell`, `rowActions`, `groupActions`), `columns` and
`columnLabels` redraw every row or group when their identity changes: keep them
stable in a host with many rows.

- **Data.** Columns `assignee` (the initials square and the name; `null` reads
  "Unassigned", or the row's `unassignedLabel` ("Needs assignee"), beside the
  same square, dashed and empty, toned by `assigneeTone`: `muted` by default,
  `warning` (amber) when the issue needs a person; give a toned placeholder its
  own words so its hue is never the only difference), `due` (`dueTone`, plus
  `dueNote`, the state in a word under the date in its voice and tone, "Overdue"
  / "Tomorrow", beside it on a stacked card) and `milestone` (the milestone's
  name, then `milestoneProject` muted after " · " and cut first, the full
  "Project › Milestone" as its tooltip; `null` reads "No milestone", muted).
  Rows: `done` (the title muted and struck through), `pending` (the loading
  hatch under the row, `aria-busy`; the text keeps its contrast) and `note` (a
  mono line after the title: "Moving to Dual-write…" muted, or "Not moved · …"
  in its tone's text colour: the planner sends `danger`, red, for every change
  that did not happen). Row `chips` take any `ChipTone` and `filled` (the
  Blocked chip is the filled amber slab, as on the projects register). Groups:
  `count` (every match; the header and section count it, `rows` may hold fewer),
  `mark` (a state, priority or avatar glyph in the status mark's place), `tags`
  (square mono tokens: "Next", "↑2"), `missingLabel` (a mono amber line under
  the heading, the checklist's "missing" voice), `footer` ("Showing 12 of 212"
  in the empty line's mono voice with host actions as accent links; a group with
  no rows and a footer shows only the footer, not the empty line), `emptyLabel`,
  `droppable`. A section without `label` draws no divider.
- **`dropColumns`** (column ids, first to give way first): a table too narrow
  for its columns beside a readable title (260px) steps down at 1160, 1000 and
  860px of its own width, each step dropping as few of these as it needs
  (`data-drop-lg|md|sm` name them, `--task-cols-lg|md|sm` hold the grid without
  them, container queries apply both); below 720px the cards show every column
  again. Without it nothing drops (and the head cells carry no `data-column`).
- **`selection`** `{ selected, onChange, toggleOnClick? }`: the host owns the
  set. A checkbox per row ("Select ENG-12"), a tri-state one per group header
  ("Select the 12 shown issues in Dual-write"; on a folded group it unfolds it)
  and in the column header ("Select all 40 shown issues"), which then stops
  being `aria-hidden` (its labels are). Click toggles and sets the anchor;
  shift-click applies the clicked row's new state to the range from the anchor,
  across groups, in drawn order. A selected row carries the 2px accent rule at
  its left edge (kept over the hover and open ink floods, and drawn as a border
  so forced colours keep it) and its checkbox fills the accent; the checkbox
  carries the state (list items never get `aria-selected`). Rows that stop being
  drawn (a folded group, a refresh) leave the selection through `onChange`.
  `toggleOnClick` is the phone's selection mode: a plain click toggles a row
  instead of opening it, and the title renders as a `role="checkbox"` button
  (named by the title, `aria-checked` the selection) rather than a link that
  would not open. `hideOnTouch` hides the checkboxes in CSS on touch screens and
  phones (`(pointer: coarse), (width <= 640px)`), so the server's markup and the
  hydrated page agree; turn it off in the host's own selection mode (a Select
  button rendered always and shown by the same query).
- **`drag`** `{ canDrop, onDrop, label }`: HTML5 drag from an 18px grip that
  shows on row hover, only under `(hover: hover) and (pointer: fine)` (nothing
  is draggable on the server or on touch). A selected row drags the whole
  selection (in drawn order), otherwise itself; the drag image is a paper label
  in a 1px ink frame reading `label(n)`. Over a group the table asks
  `canDrop(ids, groupId)` once per group per drag: `true` frames the group in
  the 2px accent (rows do not flood on hover while a drag is on) and allows the
  drop; a string is the reason, shown in the header (and as its `title`) with
  the not-allowed cursor. `droppable: false` groups are never asked. There is no
  reordering: a drop targets a group. Keep a keyboard and menu path for every
  drop (WCAG 2.5.7).
- **Header.** The column header is sticky above every in-row layer (z-index 3
  over the lead, picker, ↗ and actions cells at 2).
- **Slots.** `renderCell(column, row, group)` replaces a cell's value with a
  host control (a picker with `appearance="cell"`; return `undefined` to keep
  the plain value), `rowActions(row, group)` adds a trailing 40px cell (the
  row's "…"), `groupActions(group)` a slot at the end of each header,
  `onRowContextMenu(event, row, group)` takes right-clicks (call
  `preventDefault()` to open your menu). Keys and clicks inside a host control
  (a text field, an open picker) are never the list's.
- **Keyboard.** On top of ↑/↓, j/k, Home/End, ←/→ and ↵: with `selection`, `x`
  toggles the focused row, Shift+↑/↓ extend the selection from the anchor (it
  grows and shrinks over what the anchor started from) and move focus, ⌘/Ctrl+A
  selects every drawn row. Every other key on a row goes to `onRowKeyDown`; a
  host's single-key commands should yield while
  `useCommandPalette().isSequencePending()` is true, so G S and G P still reach
  the palette.

`ViewToolbar` lays out the list toolbar in the timeline chart toolbar's frame (a
strip in a 1px ink border): a mono search in the `.input` primitive's 36px box,
as the timeline and projects toolbars draw theirs (`onChange` per keystroke,
`onCommit` on Enter and on leaving the field, so it may fire twice for one
value; `inputRef` for a `/` shortcut), the host's triggers (pickers with
`appearance="quiet"`), and `end` actions at the right edge. `busy` sets
`aria-busy` and runs a 2px accent rule along the bottom. Phones put the search
on its own row and scroll the controls sideways. `ToolbarBadge` is the small
accent count square of a Filter trigger. `FilterChips` is a second framed strip
that collapses into the toolbar above it (`margin-top: -1px`, as the timeline's
legend row meets its toolbar): one square chip per filter ("{FIELD} is
{summary}": the field a mono key, the values in the reading voice, a mono "and"
between), a named × each, the host's add control and Clear all (`clearDisabled`
while the filters are the default); `renderEditor(face)` wraps a chip's face in
the host's picker; `unknown` draws the chip's frame and values in amber (a
missing input, beside its words "Not found"). Both strips pad their content by
`--view-toolbar-gutter` (default 18px, the block chrome's; 14px on phones); a
host may set it on an ancestor. Neither renders anything when there is nothing
to show (`FilterChips` with no chips; `BulkBar` at 0 keeps only its empty,
visually hidden live region). A chip removed while its × has focus hands focus
to the next chip (its face's picker, else its ×), else the previous one; Clear
all hands it to the add control; a host whose last chip can go places focus
itself.

`BulkBar` is the fixed toolbar at the bottom centre of the content column (the
shell sets `--shell-content-left` to its sidebar's or rail's width, 0 on phones;
outside a shell it centres on the window), drawn like the toasts: paper in a 1px
ink frame, no shadow, no radius (above the shell's tab bar on phones): "{n}
selected" in the mono key voice, spoken by a polite live region that stays
mounted (empty) at 0 so the first selection is announced, the host's action
triggers (pickers with `appearance="bar"`), ✕. `busy` ("Moving 12 issues…")
replaces the count and disables the actions (they sit in a `<fieldset>`; when it
ends, focus that fell to `<body>` goes back to the action last used, else the
first), as does a `note` ("At most 100 at a time"); `confirm` replaces the
actions with a sentence, a primary button that takes focus, and Cancel (focus
returns to the first action). Esc clears the selection (or cancels the
confirmation), ← and → move between its buttons; after `onClear` the host puts
focus back in the list. Mark a trigger's text `data-bulk-label`: it hides at
390px and below, so give each trigger a `triggerLabel`. While the bar is up
(`data-bulk-bar`) the toasts stack above it: it publishes its height through
`useBulkBarHeight()` (px, or null while no bar is up), and `ToastProvider` sets
it as `--bulk-bar-h` on its own viewport. A host list that must keep room under
its last rows reads the same hook. Nothing is set on `<html>`: an inherited
custom property there restyles every element of the page.

`NavTabs` items may take `onFollow`: a plain click calls it instead of following
`href` (a host that navigates itself and shows the change at once); a modified
or middle click still opens the link.

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
  already passes that, dagre is not run for it at all. After dagre, when the
  band above a flow's first rank is at least `CLUSTER_METRICS.liftMin` (a box)
  tall, each rank rises by the space above it and above every rank before it, so
  a frame starts in its top-left corner even when a later rank stacks higher
  (dagre centres ranks on each other); arrow points move with their rank, and a
  route end not on its box's facing side is found again on the border. A thinner
  band stays, since moving ranks bends the arrows between them. dagre's edge
  weights are whole numbers: a fractional one can leave network-simplex pivoting
  forever. Arrows between frames leave the blocker's far side and enter the
  waiting box's near side, following dagre's lane to the far side of each frame
  they leave and from the near side of each they enter, running level to that
  side before crossing to the next frame when the run passes no box (in a flow
  small enough for network-simplex the frame's ports rank after and before its
  whole flow; in a bigger one they sit beside their own items, to keep its cost
  down), so they pass the other boxes there instead of running behind them;
  arrows inside one frame keep their dagre route. Then each arrow between
  frames, and an arrow inside one whose route would pass a box, turns round
  every box in its way (and each frame title's paper patch) by the box's nearer
  side, 6px out, and where its smooth curve would still cut behind a box it is
  eased into straight runs with rounded bends (`routeAround`), so an arrow is
  not lost behind a box it does not join. Top to bottom, a frame's grid sits
  under its flow, in the way of the arrows leaving it, so frames read best left
  to right (every host uses `LR`). Given at all, even empty, `clusters` also
  packs the loose top-level nodes, so a host with no frames for a level (the
  planner's initiative level) still gets no long column. Frames are drawn
  decoratively (`data-graph-cluster`, `data-depth`, `data-muted`,
  `data-external`): a 1px `--grey-2` hairline, a mono caps title in the top-left
  on a paper patch above the arrows (ink at the top level, `--muted` nested),
  hatched with a `--grey` rule when muted, dashed when external; each node's
  accessible name says the frames it sits in ("in Beta, Orion"). The layout
  carries `clustered: true`; its nodes come in reading order (frame by frame)
  and the arrow keys move to the nearest box that way. The legend draws frames
  as `cluster` and `cluster-muted`. Flows of more than
  `CLUSTER_METRICS.simplexItems` items or `simplexLinks` links rank with dagre's
  tight-tree instead of network-simplex, which keeps one big, dense frame near
  0.5 s for 500 nodes and 800 edges (network-simplex: about 5 s).
- `DependencyGraph` `focusId`: the node the graph is about (one issue's chain,
  say). It gets a 2px ink rule inside its box and lights nothing, unlike
  `selectedId`; its accessible name ends with `focusLabel` (default "focus"),
  and Tab lands on it until a node is focused or selected. On the first paint
  the frame (never the page) scrolls so the focus, else the selected node, sits
  in its middle. With neither, it opens where the flow starts rather than on
  dagre's empty top-left corner: at the drawing's start along the flow, and
  across it at the band, starting at a box, where the most boxes of that first
  frame-length show whole (the earliest on a tie). A framed layout (`clusters`)
  opens on its first frame, which the packing puts at the top-left: it stays at
  the origin while that frame shows a box whole there, and otherwise slides to
  the band of that frame's own boxes, never to a later frame. A drawing that
  fits the frame across does not move. The legend draws the mark as
  `node-focus`.
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
  critical path". Entering `critical` (a new `highlight`, or the first paint
  with no `focusId` or `selectedId` to centre) scrolls the frame to step 1 of
  the path shown at rest unless one of its steps already shows whole. A step
  control over the frame's bottom-left corner (`data-graph-steps`: ‹, "3 steps"
  / "Step 2 of 3", ›) and the keys `]` / `[` walk that path: the walked step is
  the box being read (the accent flood, the readout) and the frame centres it;
  Escape, a tap on the background or another highlight drops it.
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

`PickerPopover` is also the family's menu: `searchable={false}` drops the search
row (the list takes focus; ↑/↓, ↵ and Space pick, Esc closes) and the key-hint
foot, and with `action` every pick is an action rather than a value (a row's
"…", Filter, Sort, Group). Two more trigger appearances serve lists: `cell` (the
trigger takes the cell's own voice, so its text sits where the plain value
would, with the value voice's hairline frame on hover) and `bar` (a mono action
on the bulk bar's paper that floods the accent on hover and is ink-filled while
its popover is open). A multiple picker whose groups each hold one choice (Sort,
Group) takes `marks="tick"`: the single picker's trailing tick instead of
checkbox squares. A `PickerOption.tone` colours the trigger's face text (from
the `data-tone` hook) while that option is the value shown, a pending one
included; `PriorityPicker` takes it per level as `priorityTones` (a list cell's
`{ 1: 'danger' }`: "Urgent" red the moment it is picked, a pending "High" never
red). `anchorPoint={{ x, y }}` opens the popover at a viewport point instead of
under its trigger (a context menu at the pointer; a phone keeps its sheet).
`returnFocus={() => element}` sends focus there instead of to the trigger when
the picker closes on Esc, a choice or a close button (a picker a host's
single-key shortcut opened from a row's title goes back to that title); Tab and
an outside click are unchanged. A disabled option wraps, so a menu's note or a
reason can be a whole sentence. `useModKeyLabel()` is "⌘" on Apple platforms and
"Ctrl" elsewhere (the server renders "Ctrl"), for a host's own shortcut rows.

## Browser behaviour hosts should know about

All of it runs in effects and event handlers on the client; server rendering
touches none of it.

- `ThemeToggle` writes `html[data-theme]` and `localStorage`.
- `AppShell` writes `html[data-shell-collapsed]` (and removes it on unmount),
  binds `[` to collapse the sidebar, and locks `<html>` scrolling while the
  phone drawer is open. `sidebarCollapseScript(key)` is its pre-paint script.
- `CommandPaletteProvider` binds Ctrl/⌘ K, `?` and two-key `G …` shortcuts on
  `document`. Do not mount it in a host that has its own command palette. Its
  API's `isSequencePending()` is true between a sequence's first key and its
  second (1.2 s): React handlers run before that document listener, so a host's
  own single keys can check it and stay out of a chord's way.
- `TaskGroupTable` with `drag` reads `(hover: hover) and (pointer: fine)`
  through a media query and appends (then removes) a drag-image element.
  `BulkBar` is `position: fixed` and lifts itself above
  `[data-shell-tabbar='true']` on phones, as the toasts do; while it is up it
  publishes its height to `useBulkBarHeight()` (null when it goes) and the
  toasts stack above it.
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
