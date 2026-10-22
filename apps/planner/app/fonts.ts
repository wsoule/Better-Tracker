import { Geist, Geist_Mono } from 'next/font/google';

// Gr8r Studio's type system: Geist for every word, Geist Mono for ids,
// keys and numbers only. The CSS variables are read by the font stacks in
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

/** localStorage key for the light/dark choice (themeScript + ThemeToggle). */
export const THEME_STORAGE_KEY = 'milestone-planner-theme';
