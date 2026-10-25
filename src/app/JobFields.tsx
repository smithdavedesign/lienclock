import type { ReactNode } from 'react';
import type { JobForm } from '@/lib/jobInput';
import { STATES, SUPPORTED_STATES } from '@/lib/rules';

type FieldName = 'state' | 'counterparty' | 'firstFurnishDate' | 'lastFurnishDate';

function FieldError({ message, id }: { message?: string; id: string }) {
  return message ? (
    <span className="error" id={id}>
      {message}
    </span>
  ) : null;
}

/** The job fields shared by the calculator, the save action and the intake review (which adds `notes`). */
export function JobFields({
  values,
  errors,
  notes = {},
}: {
  values: JobForm;
  errors: Record<string, string>;
  notes?: Partial<Record<FieldName, ReactNode>>;
}) {
  return (
    <div className="fields">
      <label>
        State
        <select name="state" defaultValue={values.state?.toUpperCase() ?? ''} required aria-describedby="state-error">
          <option value="" disabled>
            Choose…
          </option>
          {SUPPORTED_STATES.map((code) => (
            <option key={code} value={code}>
              {STATES[code].name}
            </option>
          ))}
        </select>
        {notes.state}
        <FieldError id="state-error" message={errors.state} />
      </label>
      <label>
        GC or owner you work for
        <input name="counterparty" defaultValue={values.counterparty ?? ''} maxLength={120} required aria-describedby="counterparty-error" />
        {notes.counterparty}
        <FieldError id="counterparty-error" message={errors.counterparty} />
      </label>
      <label>
        First day you furnished labor or materials
        <input type="date" name="firstFurnishDate" defaultValue={values.firstFurnishDate ?? ''} required aria-describedby="first-error" />
        {notes.firstFurnishDate}
        <FieldError id="first-error" message={errors.firstFurnishDate} />
      </label>
      <label>
        Last day you furnished (optional, add it when the job wraps)
        <input type="date" name="lastFurnishDate" defaultValue={values.lastFurnishDate ?? ''} aria-describedby="last-error" />
        {notes.lastFurnishDate}
        <FieldError id="last-error" message={errors.lastFurnishDate} />
      </label>
      <p className="scope">Private commercial project · you are a subcontractor hired by the GC.</p>
    </div>
  );
}
