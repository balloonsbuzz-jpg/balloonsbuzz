import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkle } from '@phosphor-icons/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Field } from '@/pages/ai/fields';
import { api, errorMessage } from '@/lib/api';
import { useCatalog } from '@/hooks/useCatalog';
import { inr } from '@/lib/money';

const FALLBACK_TEXT = {
  cheaper: 'Nothing in this theme fits the budget, so the bot offers the closest cheaper designs.',
  above_budget: 'Everything in this theme costs more than the budget. The bot shows the cheapest ones and says so.',
  no_match: 'No sendable photos for this combination.',
  unknown_theme: 'The bot doesn’t know this theme. Add it (or an alias) in Pricing & Rules → Themes.',
};

/** Ask the same photo picker the AI uses: what would a customer receive? */
export default function PickerPanel() {
  const { data: catalog } = useCatalog();
  const [f, setF] = useState({ theme: '', package: null, occasion: null, budget_min: '', budget_max: '', limit: 3 });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const run = useMutation({
    mutationFn: async () => (await api.post('/gallery/search', {
      theme: f.theme.trim() || undefined,
      package: f.package || undefined,
      occasion: f.occasion || undefined,
      budget_min: f.budget_min === '' ? undefined : Number(f.budget_min),
      budget_max: f.budget_max === '' ? undefined : Number(f.budget_max),
      limit: Number(f.limit),
    })).data,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const r = run.data;
  const pkgs = (catalog?.packages || []).filter((p) => p.kind === 'package').map((p) => [p.key, p.name]);
  const occs = (catalog?.occasions || []).map((o) => [o.key, o.name]);

  return (
    <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      <Card className="self-start">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Sparkle size={18} /> Try a customer request</CardTitle>
          <CardDescription>Uses the same photo picker as the AI agent, with customer words like “spidey” or “dino”.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
            <Field id="pk-theme" label="Theme"><Input id="pk-theme" value={f.theme} onChange={set('theme')} placeholder="e.g. dinosaur, spidey, barbie" /></Field>
            <Field id="pk-pkg" label="Design category"><NativeSelect id="pk-pkg" value={f.package} onChange={set('package')} options={pkgs} placeholder="Any" /></Field>
            <Field id="pk-occ" label="Occasion"><NativeSelect id="pk-occ" value={f.occasion} onChange={set('occasion')} options={occs} placeholder="Any" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field id="pk-min" label="Budget from (₹)"><Input id="pk-min" type="number" inputMode="numeric" min={0} step={500} value={f.budget_min} onChange={set('budget_min')} placeholder="10000" /></Field>
              <Field id="pk-max" label="Budget to (₹)"><Input id="pk-max" type="number" inputMode="numeric" min={0} step={500} value={f.budget_max} onChange={set('budget_max')} placeholder="12000" /></Field>
            </div>
            <Field id="pk-n" label="Photos"><NativeSelect id="pk-n" value={String(f.limit)} onChange={set('limit')} options={[1, 2, 3, 4, 5].map((n) => [String(n), String(n)])} /></Field>
            <Button type="submit" disabled={run.isPending}>{run.isPending ? 'Picking…' : 'Show photos'}</Button>
          </form>
        </CardContent>
      </Card>

      <div className="min-w-0 space-y-3">
        {!r && <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">Results appear here, with the caption the customer would see.</p>}
        {r && (
          <>
            <p className="text-sm">
              Understood as: <b>{[r.match.theme, r.match.package, r.match.occasion].filter(Boolean).join(' · ') || 'anything'}</b>
            </p>
            {r.fallback && <p className="rounded-lg bg-accent/60 px-3 py-2 text-sm text-accent-foreground">{FALLBACK_TEXT[r.fallback]}</p>}
            {r.suggestions?.length > 0 && (
              <p className="text-sm text-muted-foreground">Themes the bot can suggest instead: {r.suggestions.map((s) => `${s.name} (${s.photos}, from ${inr(s.from_price)})`).join(', ')}</p>
            )}
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {r.items.map((it) => (
                <li key={it.id} className="overflow-hidden rounded-xl border bg-[#e7ddd3] p-2 dark:bg-[#1b2a25]">
                  {/* WhatsApp-style image bubble */}
                  <div className="ml-auto max-w-[280px] rounded-lg bg-[#d9fdd3] p-1 shadow-sm dark:bg-[#005c4b]">
                    <img src={it.thumb_url} alt={it.title} className="aspect-square w-full rounded-md object-cover" />
                    <p className="px-1.5 pt-1 pb-0.5 text-[13px] leading-snug whitespace-pre-line text-[#111b21] dark:text-[#e9edef]">{it.caption}</p>
                  </div>
                  <p className="mt-1.5 px-1 text-[11px] text-[#54656f] dark:text-[#aebac1]">
                    {it.fit === 'in_budget' ? 'In budget' : it.fit === 'slightly_above' ? 'Slightly above budget' : it.fit === 'cheaper' ? 'Cheaper option' : it.fit === 'above_budget' ? 'Above budget' : 'No budget given'} · matched {it.reasons.join(', ') || 'category'}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
