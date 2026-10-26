import type { ReactNode } from 'react';

import type { PublicPage } from '../../lib/adapters/public-pages';
import styles from './public.module.css';

/* One public page (privacy, terms, contact) as a readable document: the
   title and lead, then each section's heading and its paragraphs, lists
   and two-column tables, in a centred column on the page background.
   `after` renders below a section by id (the contact page's email and
   website rows). */
export default function PublicDocument({
  page,
  after = {},
}: {
  page: PublicPage;
  after?: Record<string, ReactNode>;
}) {
  return (
    <article className={styles.doc} aria-labelledby="public-title">
      <header className={styles.head}>
        <h1 id="public-title" className={styles.title}>
          {page.title}
        </h1>
        <p className={styles.lead}>{page.lead}</p>
      </header>
      {page.sections.map((section) => (
        <section
          key={section.id}
          className={styles.section}
          aria-labelledby={`section-${section.id}`}
        >
          <h2 id={`section-${section.id}`} className={styles.sectionTitle}>
            {section.title}
          </h2>
          {section.blocks.map((block, index) => {
            const key = `${section.id}-${index}`;
            switch (block.kind) {
              case 'text':
                return (
                  <p key={key} className={styles.text}>
                    {block.text}
                  </p>
                );
              case 'list':
                return (
                  <ul key={key} className={styles.list}>
                    {block.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                );
              case 'table':
                return (
                  <table key={key} className={styles.table}>
                    <caption className="srOnly">{block.label}</caption>
                    <tbody>
                      {block.rows.map(([label, value]) => (
                        <tr key={label}>
                          <th scope="row">{label}</th>
                          <td>{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                );
            }
          })}
          {after[section.id] ?? null}
        </section>
      ))}
    </article>
  );
}
