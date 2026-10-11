import { useEffect, useState } from "react";

import { Input } from "../ui/input";

export function IntegerSettingInput({
  value,
  min,
  max,
  ariaLabel,
  disabled,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  // Local draft so the field can be emptied mid-edit; the setting only moves
  // on valid input and snaps back to the persisted value on blur.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <Input
      size="sm"
      type="number"
      min={min}
      max={max}
      className="w-full sm:w-24"
      value={draft}
      disabled={disabled}
      onChange={(event) => {
        setDraft(event.target.value);
        // Number(), not parseInt: "3.5" must be rejected (not truncated to a
        // committed 3 while the field shows 3.5) — commit only when the
        // persisted value matches the displayed one.
        const parsed = Number(event.target.value);
        if (Number.isInteger(parsed) && parsed >= min && parsed <= max) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label={ariaLabel}
    />
  );
}
