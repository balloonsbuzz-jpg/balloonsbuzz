import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Calculator, Plus, X } from '@phosphor-icons/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Field } from '@/pages/ai/fields';
import { api, errorMessage } from '@/lib/api';
import { useCatalog, catalogOptions } from '@/hooks/useCatalog';
import { inr } from '@/lib/money';
import { toNum } from './shared';

const DECISION = {
  accept: ['Accept', 'bg-success/15 text-success'],
  counter: ['Counter-offer', 'bg-accent text-accent-foreground'],
  final_offer: ['Final offer', 'bg-primary/10 text-primary'],
};

/** Same engine the AI agent will call: try a design, add-ons, a distance and a customer's offer. */
export default function QuoteTab() {
  const { data: catalog } = useCatalog();
  const opts = catalogOptions(catalog);
  const [f, setF] = useState({ package_id: null, theme_id: null, occasion_id: null, km: '', offer: '', current_ask: '', rounds_used: 0 });
  const [addons, setAddons] = useState([]);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const run = useMutation({
    mutationFn: async (over = {}) => {
      const body = { ...f, ...over };
      return (await api.post('/pricing/quote', {
        package_id: body.package_id, theme_id: body.theme_id || undefined, occasion_id: body.occasion_id || undefined,
        km: toNum(body.km) ?? undefined, offer: toNum(body.offer) ?? undefined,
        current_ask: toNum(body.current_ask) ?? undefined, rounds_used: Number(body.rounds_used || 0),
        addons: addons.filter((a) => a.package_id).map((a) => ({ package_id: a.package_id, quantity: Number(a.quantity || 1) })),
      })).data;
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const r = run.data;
  const q = r?.quote;
  const n = r?.negotiation;

  const nextRound = () => {
    const over = { current_ask: n.price, rounds_used: n.rounds_used };
    setF((x) => ({ ...x, ...over }));
    run.mutate(over);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
      <Card className="self-start">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Calculator size={18} /> Quote calculator</CardTitle>
          <CardDescription>The exact maths the AI agent uses, so you can check prices and discount limits before customers see them.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setF((x) => ({ ...x, current_ask: '', rounds_used: 0 })); run.mutate({ current_ask: '', rounds_used: 0 }); }}>
            <Field id="q-pkg" label="Design category"><NativeSelect id="q-pkg" value={f.package_id} onChange={set('package_id')} options={opts.designs} placeholder="Choose…" required /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field id="q-theme" label="Theme"><NativeSelect id="q-theme" value={f.theme_id} onChange={set('theme_id')} options={opts.themes} placeholder="Any" /></Field>
              <Field id="q-occ" label="Occasion"><NativeSelect id="q-occ" value={f.occasion_id} onChange={set('occasion_id')} options={opts.occasions} placeholder="Any" /></Field>
            </div>
            <Field id="q-addons" label="Add-ons">
              <div className="space-y-2">
                {addons.map((a, i) => (
                  <div key={i} className="flex gap-2">
                    <NativeSelect className="flex-1" aria-label={`Add-on ${i + 1}`} value={a.package_id} onChange={(v) => setAddons((xs) => xs.map((x, j) => (j === i ? { ...x, package_id: v } : x)))} options={opts.addons} placeholder="Choose…" />
                    <Input aria-label={`Add-on ${i + 1} quantity`} type="number" min={1} className="w-20" value={a.quantity} onChange={(e) => setAddons((xs) => xs.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                    <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove add-on" onClick={() => setAddons((xs) => xs.filter((_, j) => j !== i))}><X size={14} /></Button>
                  </div>
                ))}
                <Button type="button" size="sm" variant="outline" onClick={() => setAddons((xs) => [...xs, { package_id: null, quantity: 1 }])}><Plus size={14} /> Add-on</Button>
              </div>
            </Field>
            <Field id="q-km" label="Distance from base (km)" hint="Leave empty if the venue isn’t known yet"><Input id="q-km" type="number" min={0} step={0.1} value={f.km} onChange={set('km')} /></Field>
            <Field id="q-offer" label="Customer offers (₹)" hint="Optional: see how the bot would negotiate"><Input id="q-offer" type="number" min={0} step={100} value={f.offer} onChange={set('offer')} /></Field>
            <Button type="submit" disabled={!f.package_id || run.isPending}>{run.isPending ? 'Calculating…' : 'Calculate'}</Button>
          </form>
        </CardContent>
      </Card>

      <div className="min-w-0 space-y-4">
        {!q && <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">Choose a design category and press Calculate.</p>}
        {q && !q.ok && (
          <p className="rounded-xl bg-destructive/10 p-4 text-sm font-bold text-destructive">
            {q.reason === 'no_price' ? 'This category has no price yet, so the bot won’t quote it. It hands the chat to the team instead. Add a price in Design prices.'
              : q.reason === 'below_min_quantity' ? `Below the minimum quantity (${q.min_quantity}).` : 'An add-on has no price yet.'}
          </p>
        )}
        {q?.ok && (
          <Card>
            <CardHeader><CardTitle>{q.package.name}</CardTitle><CardDescription>Design range {inr(q.design_range[0])} – {inr(q.design_range[1])}: the bot quotes the top of the range.</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <table className="w-full text-sm">
                <tbody className="divide-y">
                  {q.line_items.map((l, i) => (
                    <tr key={i}><td className="py-1.5">{l.label}</td><td className="py-1.5 text-right font-bold tabular-nums">{inr(l.amount)}</td></tr>
                  ))}
                  {q.serviceable === false && <tr><td className="py-1.5 text-destructive" colSpan={2}>Outside the service area: the bot hands over to the team for travel.</td></tr>}
                  <tr className="border-t-2"><td className="py-2 font-extrabold">Full price</td><td className="py-2 text-right text-lg font-extrabold tabular-nums">{inr(q.full_price)}</td></tr>
                  <tr><td className="py-1.5 text-muted-foreground">Lowest the bot may go</td><td className="py-1.5 text-right font-bold tabular-nums">{inr(q.floor_price)}</td></tr>
                </tbody>
              </table>
              {q.unconfirmed.length > 0 && <p className="text-xs text-muted-foreground">Still to confirm: {q.unconfirmed.join(', ')}.</p>}
            </CardContent>
          </Card>
        )}
        {n && (
          <Card>
            <CardHeader><CardTitle>Customer offers {inr(f.offer)}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2.5 py-0.5 text-sm font-bold ${DECISION[n.decision][1]}`}>{DECISION[n.decision][0]}</span>
                <span className="text-2xl font-extrabold tabular-nums">{inr(n.price)}</span>
                <span className="text-sm text-muted-foreground">round {n.rounds_used} of {q.max_rounds}</span>
              </p>
              <p className="text-sm">
                {n.decision === 'accept' ? 'The offer is within the limits, so the bot agrees.'
                  : n.at_floor ? 'This is the lowest allowed price. If the customer still wants less, the bot offers this again or hands over to the team.'
                    : n.decision === 'final_offer' ? 'No more counter-offers allowed: the bot holds this price.'
                      : 'The bot comes down one step and waits for the customer.'}
                {n.below_floor && ' The customer’s offer is below the lowest allowed price.'}
              </p>
              {n.decision === 'counter' && <Button variant="outline" onClick={nextRound} disabled={run.isPending}>Customer says no again</Button>}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
