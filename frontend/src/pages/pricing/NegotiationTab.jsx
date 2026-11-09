import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash, ShieldCheck } from '@phosphor-icons/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { NativeSelect } from '@/components/ui/native-select';
import { Field } from '@/pages/ai/fields';
import { api } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { useCatalog, catalogOptions } from '@/hooks/useCatalog';
import { inr } from '@/lib/money';
import { useSave, toNum, fromNum, Hint, Unconfirmed } from './shared';

/** Same maths as the backend engine, only for the example sentence under each rule. */
function lowestPrice(list, r) {
  const caps = [];
  if (r.max_discount_pct !== '') caps.push(Math.floor((list * Number(r.max_discount_pct)) / 100));
  if (r.max_discount_amount !== '') caps.push(Number(r.max_discount_amount));
  let floor = list - (caps.length ? Math.min(...caps) : list);
  if (r.min_final_price !== '') floor = Math.max(floor, Math.min(Number(r.min_final_price), list));
  return floor;
}

export default function NegotiationTab() {
  const { can } = useAuth();
  const canWrite = can('pricing:write');
  const { data: rules = [], isLoading } = useQuery({ queryKey: ['negotiation'], queryFn: async () => (await api.get('/pricing/negotiation')).data.rules });
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="space-y-4">
      <Hint>
        When a customer asks for a discount, the bot comes down one small step at a time and <b>never goes below the lowest price</b> worked out here.
        This is enforced in code, not left to the AI. When the customer wants less than that, the bot offers the lowest price or hands the chat to your team.
      </Hint>
      <div className="grid gap-4 xl:grid-cols-2">
        {rules.map((r) => <RuleCard key={r.id} rule={r} canWrite={canWrite} />)}
      </div>
      {canWrite && <AddRule />}
    </div>
  );
}

function RuleCard({ rule, canWrite }) {
  const [f, setF] = useState(null);
  useEffect(() => setF({
    max_discount_pct: fromNum(rule.max_discount_pct), max_discount_amount: fromNum(rule.max_discount_amount), min_final_price: fromNum(rule.min_final_price),
    concession_step_pct: fromNum(rule.concession_step_pct), max_rounds: rule.max_rounds,
    applies_to_addons: rule.applies_to_addons, applies_to_distance_charge: rule.applies_to_distance_charge,
  }), [rule]);
  const save = useSave([['negotiation']]);
  if (!f) return null;
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const title = rule.scope === 'global' ? 'All designs (default)' : rule.scope === 'package' ? rule.package_name : `${rule.theme_name}${rule.package_name ? ` · ${rule.package_name}` : ''}`;
  const example = 12000;
  const noLimit = f.max_discount_pct === '' && f.max_discount_amount === '' && f.min_final_price === '';
  const submit = (e) => {
    e.preventDefault();
    save.mutate({ url: `/pricing/negotiation/${rule.id}`, body: {
      max_discount_pct: toNum(f.max_discount_pct), max_discount_amount: toNum(f.max_discount_amount), min_final_price: toNum(f.min_final_price),
      concession_step_pct: Number(f.concession_step_pct), max_rounds: Number(f.max_rounds),
      applies_to_addons: f.applies_to_addons, applies_to_distance_charge: f.applies_to_distance_charge,
    } });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2"><ShieldCheck size={18} /> {title} {/TODO/.test(rule.notes || '') && <Unconfirmed />}</CardTitle>
        <CardDescription>{rule.scope === 'global' ? 'Applies unless a category or theme has its own limit.' : `Overrides the default for ${rule.scope === 'package' ? 'this category' : 'this theme'}.`}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <fieldset disabled={!canWrite} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field id={`pct-${rule.id}`} label="Max discount %"><Input id={`pct-${rule.id}`} type="number" min={0} max={100} step={0.5} value={f.max_discount_pct} onChange={set('max_discount_pct')} placeholder="e.g. 10" /></Field>
              <Field id={`amt-${rule.id}`} label="Max discount ₹"><Input id={`amt-${rule.id}`} type="number" min={0} step={100} value={f.max_discount_amount} onChange={set('max_discount_amount')} placeholder="e.g. 1000" /></Field>
              <Field id={`min-${rule.id}`} label="Never below ₹"><Input id={`min-${rule.id}`} type="number" min={0} step={100} value={f.min_final_price} onChange={set('min_final_price')} placeholder="optional" /></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id={`step-${rule.id}`} label="Each step down (%)" hint="Of the full price, per counter-offer"><Input id={`step-${rule.id}`} type="number" min={0.5} max={100} step={0.5} value={f.concession_step_pct} onChange={set('concession_step_pct')} /></Field>
              <Field id={`rounds-${rule.id}`} label="Counter-offers allowed" hint="After these, the price stays"><Input id={`rounds-${rule.id}`} type="number" min={0} max={10} value={f.max_rounds} onChange={set('max_rounds')} /></Field>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm font-bold">Discount add-ons too<Switch checked={f.applies_to_addons} onCheckedChange={set('applies_to_addons')} aria-label="Discount add-ons too" /></label>
              <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm font-bold">Discount travel charge too<Switch checked={f.applies_to_distance_charge} onCheckedChange={set('applies_to_distance_charge')} aria-label="Discount travel charge too" /></label>
            </div>
          </fieldset>
          <p className="rounded-lg bg-muted px-3 py-2 text-sm">
            {noLimit ? 'Set at least one limit.' : <>Example: on a {inr(example)} design the lowest price is <b>{inr(lowestPrice(example, f))}</b>. With both a % and a ₹ limit, the smaller discount applies.</>}
          </p>
          {canWrite && (
            <div className="flex gap-2">
              <Button type="submit" disabled={save.isPending || noLimit}>Save</Button>
              {rule.scope !== 'global' && (
                <Button type="button" variant="ghost" onClick={() => window.confirm('Remove this limit? The default limit will apply.') && save.mutate({ method: 'delete', url: `/pricing/negotiation/${rule.id}` })}>
                  <Trash size={15} /> Remove
                </Button>
              )}
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function AddRule() {
  const { data: catalog } = useCatalog();
  const opts = catalogOptions(catalog);
  const [scope, setScope] = useState('package');
  const [target, setTarget] = useState(null);
  const [pct, setPct] = useState('');
  const save = useSave([['negotiation']], { success: 'Limit added' });
  return (
    <Card>
      <CardHeader><CardTitle>Different limit for one category or theme</CardTitle></CardHeader>
      <CardContent>
        <form className="grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)_140px_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ method: 'post', url: '/pricing/negotiation', body: { scope, [scope === 'package' ? 'package_id' : 'theme_id']: target, max_discount_pct: Number(pct) } },
              { onSuccess: () => { setTarget(null); setPct(''); } });
          }}>
          <NativeSelect aria-label="Applies to" value={scope} onChange={(v) => { setScope(v); setTarget(null); }} options={[['package', 'A category'], ['theme', 'A theme']]} />
          <NativeSelect aria-label={scope === 'package' ? 'Category' : 'Theme'} value={target} onChange={setTarget} options={scope === 'package' ? opts.designs : opts.themes} placeholder="Choose…" />
          <Input aria-label="Max discount %" type="number" min={0} max={100} step={0.5} placeholder="Max discount %" value={pct} onChange={(e) => setPct(e.target.value)} />
          <Button type="submit" disabled={!target || pct === '' || save.isPending}><Plus size={15} /> Add</Button>
        </form>
      </CardContent>
    </Card>
  );
}
