import { CaretDown } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';

/** Styled native <select>: labels for id values, works well on phones. options: [[value, label]] */
export function NativeSelect({ className, options = [], placeholder, value, onChange, ...props }) {
  return (
    <div className={cn('relative', className)}>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        className="h-8 w-full appearance-none rounded-lg border border-input bg-transparent py-1 pr-8 pl-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30"
        {...props}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <CaretDown size={14} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}
