import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import { modelSpelling } from '@craftingtable/domain';
import { useState } from 'react';

export type ModelOption = ExecutionStatusResponse['backends'][number]['models'][number];

const CUSTOM_MODEL = '__custom__';

/** What the picker calls a catalog's sections; another section shows by its own name. */
const SECTION_LABELS: Readonly<Record<string, string>> = {
  alias: 'Current of each tier',
  main: 'Models',
  overflow: 'More models',
};

/** The models to offer, by section in the catalog's order. Hidden ones only when chosen. */
function sections(models: readonly ModelOption[], value: string) {
  const groups = new Map<string, ModelOption[]>();
  for (const model of models) {
    if (model.hidden && model.id !== value) continue;
    groups.set(model.section, [...(groups.get(model.section) ?? []), model]);
  }
  return [...groups];
}

/**
 * A model picker fed by the backend's catalog (R-G15): grouped by section, showing display
 * names, always sending the id. "Other…" takes any id; one the catalog does not list is a
 * warning, and a display name or another spelling of an id is offered the catalog's id
 * (LIVE-34).
 */
export function ModelField({
  models,
  value,
  onChange,
  disabled,
}: {
  models: readonly ModelOption[];
  value: string;
  onChange: (model: string) => void;
  disabled: boolean;
}) {
  const groups = sections(models, value);
  const offered = (id: string) => groups.some(([, group]) => group.some((m) => m.id === id));
  const [custom, setCustom] = useState(value !== '' && !offered(value));
  const selectValue = custom ? CUSTOM_MODEL : value;
  const spelling = custom && value.trim() !== '' ? modelSpelling(models, value) : undefined;
  const options = (group: readonly ModelOption[]) =>
    group.map((option) => (
      <option key={option.id} value={option.id}>
        {option.label}
      </option>
    ));
  return (
    <>
      <label className="field">
        Model
        <select
          value={selectValue}
          onChange={(event) => {
            if (event.target.value === CUSTOM_MODEL) {
              setCustom(true);
              onChange('');
            } else {
              setCustom(false);
              onChange(event.target.value);
            }
          }}
          disabled={disabled}
        >
          <option value="">Backend default</option>
          {groups.length === 1
            ? options(groups[0]?.[1] ?? [])
            : groups.map(([section, group]) => (
                <optgroup key={section} label={SECTION_LABELS[section] ?? section}>
                  {options(group)}
                </optgroup>
              ))}
          <option value={CUSTOM_MODEL}>Other…</option>
        </select>
      </label>
      {custom && (
        <label className="field">
          Model id
          <input
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Model id"
            disabled={disabled}
            maxLength={100}
          />
        </label>
      )}
      {spelling?.kind === 'misnamed' && (
        <p className="warning-state" role="alert">
          The catalog lists “{value.trim()}” as {spelling.label}, whose id is{' '}
          <code>{spelling.id}</code>. Only the id is sent; a run with any other spelling is not
          started.{' '}
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={() => {
              setCustom(!offered(spelling.id));
              onChange(spelling.id);
            }}
          >
            Use {spelling.id}
          </button>
        </p>
      )}
      {spelling?.kind === 'unlisted' && (
        <p className="warning-state" role="note">
          Not in this agent’s model list. It is sent as typed, so check it is a model id.
        </p>
      )}
    </>
  );
}
