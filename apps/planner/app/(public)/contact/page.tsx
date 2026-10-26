import {
  contactDetails,
  contactPage,
} from '../../../lib/adapters/public-pages';
import { loadPublicFacts } from '../../../lib/public-facts';
import { getEngine } from '../../../lib/runtime';
import PublicDocument from '../public-document';
import styles from '../public.module.css';

export const metadata = { title: 'Contact' };

/* /contact (architecture §8.4 "Public pages"): who runs the planner
   (OPERATOR_NAME) and how to reach them (OPERATOR_EMAIL, OPERATOR_URL), or
   a neutral line when none is set. Linear's app directory asks every
   public app for a developer URL; deploy.md points it here. No session,
   no Linear call. */
export default async function ContactPage() {
  const facts = await loadPublicFacts(await getEngine());
  const details = contactDetails(facts.operator);
  return (
    <PublicDocument
      page={contactPage(facts)}
      after={{
        who:
          details.length === 0 ? null : (
            <dl className={styles.details}>
              {details.map((row) => (
                <div key={row.id} className={styles.detail}>
                  <dt>{row.label}</dt>
                  <dd>
                    <a
                      className="accentLink"
                      href={row.href}
                      {...(row.id === 'url'
                        ? { rel: 'noopener noreferrer' }
                        : {})}
                    >
                      {row.value}
                    </a>
                  </dd>
                </div>
              ))}
            </dl>
          ),
      }}
    />
  );
}
