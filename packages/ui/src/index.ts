// Public API of @better-tracker/ui. Every component takes plain props (see
// ./types.ts) and renders links through the host-injected component (see
// ./lib/link.tsx), so the package carries no framework or domain coupling.
// Import '@better-tracker/ui/styles.css' once, globally, in the host.
export * from './types';
export { Link, UiLinkProvider } from './lib/link';
export { themeScript } from './lib/theme';
export { default as BlockBar } from './components/block-bar';
export { default as StatusMark } from './components/status-mark';
export { default as Tabs, type TabItem } from './components/tabs';
export { default as ThemeToggle } from './components/theme-toggle';

// ---- tasks family (src/tasks): primitives, the grouped task table,
// deadlines, stats strip and registers. Props are typed in ./tasks/types.
export { Button } from './tasks/button';
export { Checklist } from './tasks/checklist';
export { Chip } from './tasks/chip';
export {
  parseCollapsed,
  serializeCollapsed,
  toggleCollapsed,
} from './tasks/collapsed-groups';
export { DeadlineList } from './tasks/deadline-list';
export { EmptyState, Notice } from './tasks/notice';
export { ProgressRule } from './tasks/progress-rule';
export { Register, RegisterCell, RegisterRow } from './tasks/register';
export { SegmentedControl } from './tasks/segmented-control';
export { StatsStrip } from './tasks/stats-strip';
export { Switch } from './tasks/switch';
export { PriorityGlyph, StateGlyph } from './tasks/task-glyphs';
export { TaskGroupTable } from './tasks/task-group-table';
export type {
  ButtonAsButtonProps,
  ButtonAsLinkProps,
  ButtonProps,
  ButtonSize,
  ButtonVariant,
  ChecklistItem,
  ChecklistProps,
  ChipProps,
  ChipTone,
  DeadlineGroup,
  DeadlineItem,
  DeadlineListProps,
  EmptyStateProps,
  NoticeProps,
  ProgressRuleProps,
  RegisterCellProps,
  RegisterButtonRowProps,
  RegisterColumn,
  RegisterLinkRowProps,
  RegisterPlainRowProps,
  RegisterProps,
  RegisterRowProps,
  SegmentedControlProps,
  SegmentedOption,
  StatCell,
  StatsStripProps,
  SwitchProps,
  TaskChipData,
  TaskColumnId,
  TaskGroupData,
  TaskGroupProgress,
  TaskGroupTableProps,
  TaskPriority,
  TaskRowData,
  TaskSectionData,
  TaskStateKind,
} from './tasks/types';

// ---- shell family (src/shell): the app frame and overlays (architecture
// §8.3) — AppShell, SignedOutFrame, command palette + shortcuts, toasts,
// slide-over, property list, alert strip, skeletons, key caps. Props are
// typed in ./shell/types.
export { default as AlertStrip } from './shell/alert-strip';
export { default as AppShell } from './shell/app-shell';
export {
  CommandPalette,
  CommandPaletteProvider,
  shortcutCode,
  ShortcutSheet,
  useCommandPalette,
  useOptionalCommandPalette,
} from './shell/command-palette';
export { type FuzzyMatch, fuzzyMatch, highlightRuns } from './shell/fuzzy';
export { Kbd, KbdKeys } from './shell/kbd';
export { default as PropertyList } from './shell/property-list';
export { sidebarCollapseScript } from './shell/sidebar-script';
export { default as SignedOutFrame } from './shell/signed-out-frame';
export {
  Skeleton,
  SkeletonBlock,
  SkeletonRows,
  SkeletonText,
} from './shell/skeleton';
export { default as SlideOver } from './shell/slide-over';
export { ToastProvider, useToast } from './shell/toast';
export type {
  AlertStripAction,
  AlertStripProps,
  AppShellProps,
  CommandPaletteApi,
  CommandPaletteProps,
  CommandPaletteProviderProps,
  KbdKeysProps,
  KbdProps,
  PaletteItem,
  PaletteView,
  PropertyListItem,
  PropertyListProps,
  ShellCrumb,
  ShellIcon,
  ShellIconProps,
  ShellNavItem,
  ShellSection,
  ShellSectionItem,
  ShellSettingsLink,
  ShellSignOut,
  ShellTab,
  ShellUser,
  ShortcutGroup,
  ShortcutRow,
  ShortcutSheetProps,
  SignedOutFrameProps,
  SkeletonBlockProps,
  SkeletonProps,
  SkeletonRowsProps,
  SkeletonTextProps,
  SlideOverProps,
  ToastApi,
  ToastInput,
  ToastKind,
  ToastProviderProps,
} from './shell/types';

// ---- timeline family (src/timeline): the Gr8r Gantt in the Matrix
// drawing style (architecture §8.4 Timeline) — TimelineChart plus the pure
// date↔x helpers it is built on. Props are typed in ./timeline/types.
export {
  addDays,
  centerXForDate,
  createScale,
  dateForX,
  dayIndex,
  daysBetween,
  dayTicks,
  formatDay,
  formatDayLong,
  isoForDayIndex,
  monthSpans,
  snapDays,
  type TimeScale,
  weekendSpans,
  weekTicks,
  xForDate,
} from './timeline/dates';
export { TimelineChart } from './timeline/timeline-chart';
export type {
  TimelineBar,
  TimelineChartProps,
  TimelineDependency,
  TimelineGroup,
  TimelineLane,
  TimelineLegendItem,
  TimelineUndated,
  TimelineZoom,
} from './timeline/types';
