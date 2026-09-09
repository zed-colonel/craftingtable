import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import { useState } from 'react';

export type ModelOption = ExecutionStatusResponse['backends'][number]['models'][number];

const CUSTOM_MODEL = '__custom__';

/** A model picker fed by the backend, with a free-text escape hatch. */
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
  const known = value === '' || models.some((option) => option.id === value);
  const [custom, setCustom] = useState(!known);
  const selectValue = custom ? CUSTOM_MODEL : value;
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
          {models.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
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
    </>
  );
}
