/**
 * Esc in a drawer's form field that holds unsaved text: puts the saved
 * value back and marks the key handled (preventDefault), so the slide-over
 * around it, which closes on any Esc nothing else handled, stays open and
 * the typing is not silently lost. The next Esc, on a clean field, closes
 * the drawer as usual (like the issue description editor's second Esc).
 */
export function escapeResetsDraft(
  event: { key: string; preventDefault(): void },
  dirty: boolean,
  reset: () => void
): void {
  if (event.key !== 'Escape' || !dirty) return;
  event.preventDefault();
  reset();
}
