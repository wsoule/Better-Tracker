import { Geist, Geist_Mono } from 'next/font/google';

// Gr8r Studio's type system: Geist for every word, Geist Mono for ids and
// keys only. The CSS variables are read by the font stacks in
// @better-tracker/ui's tokens.css. Shared by both root layouts.
export const geist = Geist({
  variable: '--font-geist',
  subsets: ['latin'],
  display: 'swap',
});

export const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
});

/** @deprecated The mono face is Geist Mono now; use `geistMono` (both
    layouts and global-error do). Kept only so the branches still to be
    merged (graph lock-on, API-key connect), whose layouts import the old
    name, compile and get the new face; drop it after those merges. */
export const jetbrainsMono = geistMono;

/** localStorage key for the light/dark choice (themeScript + ThemeToggle). */
export const THEME_STORAGE_KEY = 'milestone-planner-theme';
