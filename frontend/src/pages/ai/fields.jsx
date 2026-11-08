import { useState } from 'react';
import { X } from '@phosphor-icons/react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export function Field({ id, label, hint, error, className, children }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id} className="font-bold">{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function NumberField({ id, label, hint, value, onChange, min, max, step = 1, suffix }) {
  const invalid = value === '' || Number.isNaN(Number(value)) || (min != null && Number(value) < min) || (max != null && Number(value) > max);
  return (
    <Field id={id} label={label} hint={hint} error={invalid ? `Enter a number${min != null ? ` from ${min}` : ''}${max != null ? ` to ${max}` : ''}` : undefined}>
      <div className="flex items-center gap-2">
        <Input id={id} type="number" inputMode="decimal" min={min} max={max} step={step} value={value}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} className="max-w-36" />
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      </div>
    </Field>
  );
}

/** Chip input for short phrases (e.g. handover keywords). */
export function ChipsInput({ id, value = [], onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim().toLowerCase();
    if (v && !value.includes(v)) onChange([...value, v]);
    setDraft('');
  };
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent p-1.5 focus-within:ring-3 focus-within:ring-ring/40">
      {value.map((chip) => (
        <span key={chip} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-bold text-secondary-foreground">
          {chip}
          <button type="button" aria-label={`Remove ${chip}`} onClick={() => onChange(value.filter((c) => c !== chip))} className="opacity-60 hover:opacity-100">
            <X size={12} weight="bold" />
          </button>
        </span>
      ))}
      <input
        id={id}
        className="min-w-32 flex-1 bg-transparent px-1 text-sm outline-none"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
          if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
      />
    </div>
  );
}
