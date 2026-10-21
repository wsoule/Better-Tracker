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
