import { Geist, JetBrains_Mono } from 'next/font/google';

// The Analytics type system: Geist for the sans/body voices, JetBrains Mono
// for the machine voice. Shared by both root layouts.
export const geist = Geist({
  variable: '--font-geist',
  subsets: ['latin'],
  display: 'swap',
});

export const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains',
  subsets: ['latin'],
  display: 'swap',
});

/** localStorage key for the light/dark choice (themeScript + ThemeToggle). */
export const THEME_STORAGE_KEY = 'milestone-planner-theme';
