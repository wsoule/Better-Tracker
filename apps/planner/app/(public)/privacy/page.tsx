import { privacyPage } from '../../../lib/adapters/public-pages';
import { loadPublicFacts } from '../../../lib/public-facts';
import { getEngine } from '../../../lib/runtime';
import PublicDocument from '../public-document';

export const metadata = { title: 'Privacy' };

/* /privacy (architecture §8.4 "Public pages"): what the planner stores,
   where, for how long and how to have it deleted, for this deployment's
   mode, with every retention number from the engine's constants and
   config (lib/adapters/public-pages.ts). No session, no Linear call. */
export default async function PrivacyPage() {
  const facts = await loadPublicFacts(await getEngine());
  return <PublicDocument page={privacyPage(facts)} />;
}
