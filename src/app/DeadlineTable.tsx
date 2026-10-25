import type { ReactNode } from 'react';
import { statusLabel, type Deadline } from '@/lib/deadlines';

function timing(d: Deadline): string {
  if (d.doneDate) return `Done ${d.doneDate}`;
  if (d.daysLeft === 0) return 'Due today';
  if (d.daysLeft === 1) return '1 day left';
  if (d.daysLeft > 1) return `${d.daysLeft} days left`;
  return d.daysLeft === -1 ? 'Passed yesterday' : `Passed ${-d.daysLeft} days ago`;
}

function protection(d: Deadline): string | null {
  if (d.status === 'partial' && d.protectedFrom) {
    return `Served late: your notice protects work from ${d.protectedFrom} onward, not before.`;
  }
  if (d.status === 'protected' && d.protectedFrom) return `Covers work from ${d.protectedFrom}.`;
  return null;
}

export function DeadlineTable({ deadlines, action }: { deadlines: Deadline[]; action?: (d: Deadline) => ReactNode }) {
  if (deadlines.length === 0) return <p className="empty">No deadlines yet.</p>;
  return (
    <table className="deadlines">
      <thead>
        <tr>
          <th scope="col">Deadline</th>
          <th scope="col">Due</th>
          <th scope="col">Status</th>
          <th scope="col">Statute</th>
          {action && <th scope="col">Done on</th>}
        </tr>
      </thead>
      <tbody>
        {deadlines.map((d) => (
          <tr key={d.key} className={`row-${d.status}`}>
            <td>
              <strong>{d.title}</strong>
              <p className="note">{d.note}</p>
            </td>
            <td data-label="Due">
              <time dateTime={d.date}>{d.date}</time>
              <br />
              <span className="timing">{timing(d)}</span>
            </td>
            <td>
              <span className={`badge badge-${d.status}`}>{statusLabel(d.status)}</span>
              {protection(d) && <p className="protection">{protection(d)}</p>}
            </td>
            <td data-label="Statute">
              <a href={d.citationUrl} target="_blank" rel="noopener noreferrer">
                {d.citation}
              </a>
              <br />
              <small>{`Last verified ${d.lastVerified}`}</small>
            </td>
            {action && <td data-label="Done on">{action(d)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
