import { termsPage } from '../../../lib/adapters/public-pages';
import { loadPublicFacts } from '../../../lib/public-facts';
import { getEngine } from '../../../lib/runtime';
import PublicDocument from '../public-document';

export const metadata = { title: 'Terms' };

/* /terms (architecture §8.4 "Public pages"): provided as is, what the
   planner writes to Linear, acceptable use, and that whoever runs it may
   remove or block a workspace. No session, no Linear call. */
export default async function TermsPage() {
  const facts = await loadPublicFacts(await getEngine());
  return <PublicDocument page={termsPage(facts)} />;
}
