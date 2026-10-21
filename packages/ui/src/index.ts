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
