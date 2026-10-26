// The test-only LINEAR_API_URL in OAuth mode (architecture §10, §11): a
// local fake Linear (loopback only, config.ts parseTestEndpoint) stands in
// for both of Linear's hosts, so a browser test can sign in, install and
// edit without the network. GraphQL goes to the variable's URL itself, as
// in api_key mode; every other https://api.linear.app path (the token and
// revoke endpoints) and https://linear.app/oauth/authorize go to the same
// path at its origin. Without the variable nothing here runs, and every
// call and link names Linear exactly as before.

import {
  type FetchLike,
  LINEAR_AUTHORIZE_URL,
  LINEAR_GRAPHQL_ENDPOINT,
} from '@better-tracker/linear';

/** Linear's API host, with the slash that ends its origin. */
const LINEAR_API_PREFIX = 'https://api.linear.app/';
/** The origin of Linear's authorize page. */
const LINEAR_WEB_ORIGIN = 'https://linear.app';

/**
 * `url` sent to the test endpoint instead of Linear's API host: Linear's
 * GraphQL endpoint becomes `endpoint`, any other path on
 * https://api.linear.app keeps its path (and query) at `endpoint`'s origin.
 * Any other URL comes back unchanged.
 */
export function viaTestEndpoint(url: string, endpoint: string): string {
  if (url === LINEAR_GRAPHQL_ENDPOINT) return endpoint;
  if (!url.startsWith(LINEAR_API_PREFIX)) return url;
  return `${new URL(endpoint).origin}/${url.slice(LINEAR_API_PREFIX.length)}`;
}

/**
 * A fetch that sends every call to Linear's API host (GraphQL, token,
 * revoke) to the test endpoint (viaTestEndpoint) and passes the rest to
 * `base` untouched. createEngineFromEnv wraps the engine's and the
 * provider's fetch with it when OAuth mode has a test endpoint.
 */
export function fetchViaTestEndpoint(
  endpoint: string,
  base: FetchLike
): FetchLike {
  return (url, init) => base(viaTestEndpoint(url, endpoint), init);
}

/**
 * Linear's authorize URL (https://linear.app/oauth/authorize?…) at the test
 * endpoint's origin, its query kept, so the browser goes to the fake's
 * workspace chooser. Any other URL comes back unchanged.
 */
export function authorizeUrlViaTestEndpoint(
  url: string,
  endpoint: string
): string {
  if (
    url !== LINEAR_AUTHORIZE_URL &&
    !url.startsWith(`${LINEAR_AUTHORIZE_URL}?`)
  ) {
    return url;
  }
  return `${new URL(endpoint).origin}${url.slice(LINEAR_WEB_ORIGIN.length)}`;
}
