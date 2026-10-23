import { containsLinearCredential } from '@better-tracker/core';

// Text that holds a Linear credential is refused in the browser before it
// goes anywhere (architecture §8 "API-key mode", security S14): a key
// pasted into the issue search, the command palette or the relation
// picker's search would otherwise land in a URL, the browser history and
// the host's HTTP logs. Nobody has a reason to search for a key, so this
// holds in every mode.

/** What the refused field says instead (the engine's own sentence). */
export const KEY_TEXT_REFUSAL =
  'That looks like a Linear API key; it was not sent.';

/** KEY_TEXT_REFUSAL when `text` holds a credential-shaped run, else null. */
export function refuseKeyText(text: string): string | null {
  return containsLinearCredential(text) ? KEY_TEXT_REFUSAL : null;
}

// `text` percent-decoded once (as Next decodes it), or as it is when it
// is not valid percent-encoding.
function decodedOnce(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Where a page request whose URL holds a Linear credential goes instead
 * (proxy.ts, LINEAR_AUTH=api_key; architecture §8.1 "No key in a page
 * URL"): the same path without the query parameters that hold one, or "/"
 * when the path itself does. Null when the URL holds none, so the request
 * goes ahead. A key pasted into the address bar or a link would otherwise
 * come back in the page: Next echoes the request URL (path and query) in
 * the RSC payload of every page it renders, whatever the page does with it.
 */
export function urlWithoutKeys(
  pathname: string,
  search: string
): string | null {
  if (
    containsLinearCredential(pathname) ||
    containsLinearCredential(decodedOnce(pathname))
  ) {
    return '/';
  }
  if (
    !containsLinearCredential(search) &&
    !containsLinearCredential(decodedOnce(search))
  ) {
    return null;
  }
  const kept = new URLSearchParams();
  for (const [name, value] of new URLSearchParams(search)) {
    if (containsLinearCredential(name) || containsLinearCredential(value)) {
      continue;
    }
    kept.append(name, value);
  }
  const query = kept.toString();
  // Encoded so oddly that no single parameter holds it: drop the query.
  if (containsLinearCredential(decodedOnce(query))) return pathname;
  return query === '' ? pathname : `${pathname}?${query}`;
}
