import { useEffect, useRef } from "react";
import { ALL_PARTS, type PartGroup } from "../lib/splunkBuild";

/** A checkbox that can also show "some selected". */
function TriCheckbox({
  checked,
  some,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  some: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some && !checked;
  }, [some, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
      aria-label={label}
    />
  );
}

/** Choose which parts of the catalog a build reads: all of them, a group, or one by one. */
export function PartsPicker({
  groups,
  selected,
  onChange,
  disabled,
}: {
  groups: PartGroup[];
  selected: string[];
  onChange: (parts: string[]) => void;
  disabled?: boolean;
}) {
  const on = new Set(selected);
  // Keep the canonical order whatever the clicking order.
  const set = (ids: string[], value: boolean) => {
    const next = new Set(on);
    for (const id of ids) {
      if (value) next.add(id);
      else next.delete(id);
    }
    onChange(ALL_PARTS.filter((id) => next.has(id)));
  };
  const all = ALL_PARTS.every((id) => on.has(id));

  return (
    <fieldset className="parts" disabled={disabled}>
      <legend>Parts to read</legend>
      <label className="parts-all">
        <TriCheckbox
          checked={all}
          some={on.size > 0}
          onChange={(v) => set(ALL_PARTS, v)}
          label="Select all parts"
        />{" "}
        <strong>Select all</strong>{" "}
        <span className="muted">
          ({on.size} of {ALL_PARTS.length})
        </span>
      </label>
      <div className="parts-groups">
        {groups.map((g) => {
          const ids = g.parts.map((p) => p.id);
          const count = ids.filter((id) => on.has(id)).length;
          return (
            <div key={g.name} className="parts-group">
              <label className="parts-group-name">
                <TriCheckbox
                  checked={count === ids.length}
                  some={count > 0}
                  onChange={(v) => set(ids, v)}
                  label={`Select all of ${g.name}`}
                />{" "}
                <strong>{g.name}</strong>
              </label>
              {g.parts.map((p) => (
                <label key={p.id} className="parts-item">
                  <input
                    type="checkbox"
                    checked={on.has(p.id)}
                    onChange={(e) => {
                      // A part comes with what it needs (field discovery needs the inventory),
                      // and leaving a part out leaves out the parts that need it.
                      const value = e.target.checked;
                      const needers = groups.flatMap((x) => x.parts).filter((q) => q.needs === p.id);
                      set(
                        value ? [p.id, ...(p.needs ? [p.needs] : [])] : [p.id, ...needers.map((q) => q.id)],
                        value,
                      );
                    }}
                  />{" "}
                  {p.label}
                  {p.searches && (
                    <span className="part-tag" title="Runs Splunk searches (subject to the search time limit)">
                      search
                    </span>
                  )}
                  {p.slow && (
                    <span className="part-tag part-tag-slow" title="Can take a while on a large Splunk">
                      slow
                    </span>
                  )}
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
