import type { Metadata } from 'next';
import { listRuleChanges, type ChangeItem } from '@/lib/changelog';
import { getDb } from '@/lib/db';
import { RULES, STATES, SUPPORTED_STATES } from '@/lib/rules';
import { publicPageMetadata } from '../seo';

export const metadata: Metadata = publicPageMetadata({
  path: '/changelog',
  title: 'Lien and notice rule changes by state — LienClock',
  description: 'The states LienClock covers, the statutes behind each deadline, and every change to its rules.',
});

// Changes are recorded by the daily cron, so read them on every request.
export const dynamic = 'force-dynamic';

const BY_NAME = [...SUPPORTED_STATES].sort((a, b) => STATES[a].name.localeCompare(STATES[b].name));
const LABEL: Record<ChangeItem['change'], string> = { added: 'New', changed: 'Changed', removed: 'Removed' };

function Field({ item, label, before, after }: { item: ChangeItem; label: string; before: string; after: string }) {
  if (item.change === 'added') return <li>{`${label}: ${after}`}</li>;
  if (item.change === 'removed') return <li>{`${label} was: ${before}`}</li>;
  return (
    <li>
      {`${label}: `}
      <del>{before || '(none)'}</del>
      {' → '}
      <ins>{after || '(none)'}</ins>
    </li>
  );
}

export default async function ChangelogPage() {
  const changes = await listRuleChanges(await getDb());

  return (
    <>
      <h1>Rule changes</h1>
      <p className="lede">
        LienClock’s deadlines come from a table of rules, each checked against the state’s statute. When a rule changes,
        it’s listed here, and everyone who tracks a job in that state gets an email saying what changed.
      </p>

      <section aria-labelledby="states-heading">
        <h2 id="states-heading">{`States covered (${SUPPORTED_STATES.length})`}</h2>
        <p className="hint">Private commercial projects, for subcontractors hired by the general contractor.</p>
        <table className="deadlines coverage">
          <thead>
            <tr>
              <th scope="col">State</th>
              <th scope="col">Deadlines tracked</th>
              <th scope="col">Last verified</th>
            </tr>
          </thead>
          <tbody>
            {BY_NAME.map((code) => {
              const rules = RULES.rules.filter((r) => r.state === code);
              const verified = rules.map((r) => r.lastVerified).sort().at(-1);
              return (
                <tr key={code}>
                  <td>
                    <strong>{STATES[code].name}</strong>
                  </td>
                  <td data-label="Deadlines">
                    <ul className="rules">
                      {rules.map((r) => (
                        <li key={r.id}>
                          {`${r.title} · `}
                          <a href={r.citationUrl} target="_blank" rel="noopener noreferrer">
                            {r.citation}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td data-label="Last verified">
                    <time dateTime={verified}>{verified}</time>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="changes-heading">
        <h2 id="changes-heading">Changes</h2>
        {changes.length === 0 ? (
          <p className="empty">{`No rule changes recorded yet. The current rules are version ${RULES.version}.`}</p>
        ) : (
          <ol className="changes">
            {changes.map((change) => (
              <li key={change.id}>
                <h3>
                  {change.stateName}{' '}
                  <small>
                    <time dateTime={change.createdAt}>{change.createdAt.slice(0, 10)}</time>
                    {` · rules version ${change.rulesVersion}`}
                  </small>
                </h3>
                <ul>
                  {change.items.map((item) => (
                    <li key={item.ruleId}>
                      <strong>{`${LABEL[item.change]}: ${item.title}`}</strong>
                      <ul className="fields">
                        {item.fields.map((f) => (
                          <Field key={f.label} item={item} {...f} />
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
