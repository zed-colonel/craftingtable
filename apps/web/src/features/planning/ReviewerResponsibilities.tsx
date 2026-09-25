import type { CrossProjectView } from '@craftingtable/contracts';
export function ReviewerResponsibilities({
  label,
  roles,
  selected,
  nodes,
  disabled,
  onChange,
}: {
  label: string;
  roles: readonly string[];
  selected: readonly string[];
  nodes?: CrossProjectView['nodes'];
  disabled: boolean;
  onChange: (roles: string[]) => void;
}) {
  const primary = roles.filter(
    (role) =>
      !nodes || selected.includes(role) || nodes.some((n) => n.reviewerRoles?.includes(role)),
  );
  const other = roles.filter((role) => !primary.includes(role));
  const field = (role: string, showContext: boolean) => {
    const scopes = nodes?.filter((n) => n.reviewerRoles?.includes(role)) ?? [];
    return (
      <div key={role}>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={selected.includes(role)}
            onChange={(e) =>
              onChange(e.target.checked ? [...selected, role] : selected.filter((r) => r !== role))
            }
          />
          <span>{role}</span>
        </label>
        {nodes && showContext && (
          <p className="hint">
            {scopes.length
              ? `Required by ${scopes.length} selected review scopes, including ${scopes
                  .slice(0, 2)
                  .map((n) => n.sourceId)
                  .join(', ')}.`
              : 'Saved selection; no selected automated review scope declares this responsibility.'}
          </p>
        )}
      </div>
    );
  };
  return (
    <fieldset disabled={disabled} className="reviewer-responsibilities">
      <legend>{label}</legend>
      <p>{selected.length} responsibilities selected. Each checkbox is independent.</p>
      {primary.map((role) => field(role, true))}
      {other.length > 0 && (
        <details>
          <summary>Other imported responsibilities ({other.length})</summary>
          <p className="hint">
            Not required by the selected supported review scopes. Some imported checkpoint roles
            need external evidence the current adapter does not handle.
          </p>
          {other.map((role) => field(role, false))}
        </details>
      )}
    </fieldset>
  );
}
