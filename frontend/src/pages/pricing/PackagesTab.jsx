import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash } from '@phosphor-icons/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { useCatalog, catalogOptions } from '@/hooks/useCatalog';
import { priceRange } from '@/lib/money';
import { useSave, toNum, fromNum, Hint, Unconfirmed } from './shared';

export default function PackagesTab() {
  const { data: catalog, isLoading } = useCatalog();
  const { can } = useAuth();
  const canWrite = can('pricing:write');
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const groups = [
    ['package', 'Design categories', 'Used when the customer hasn’t picked a specific photo. A photo’s own price (from its name) always wins.'],
    ['addon', 'Add-ons', 'Extras added on top of a design.'],
    ['unit', 'Sold per piece', 'Priced per unit, e.g. per bunch.'],
  ];
  return (
    <div className="space-y-4">
      <Hint>Prices were read from the Drive folder names and are marked <b>to confirm</b> until the owner checks them. Turn on “Confirmed” once a price is final.</Hint>
      {groups.map(([kind, title, desc]) => (
        <Card key={kind}>
          <CardHeader><CardTitle>{title}</CardTitle><CardDescription>{desc}</CardDescription></CardHeader>
          <CardContent className="px-3 sm:px-6">
            <div className="hidden grid-cols-[minmax(0,1fr)_100px_100px_90px_70px_70px] gap-3 px-2 pb-2 text-xs font-bold text-muted-foreground md:grid">
              <span>Category</span><span>From (₹)</span><span>To (₹)</span><span>Confirmed</span><span>Active</span><span />
            </div>
            <ul className="divide-y">
              {catalog.packages.filter((p) => p.kind === kind).map((p) => <PackageRow key={p.id} p={p} canWrite={canWrite} />)}
            </ul>
          </CardContent>
        </Card>
      ))}
      <RulesCard canWrite={canWrite} />
    </div>
  );
}

function PackageRow({ p, canWrite }) {
  const [f, setF] = useState({});
  useEffect(() => setF({ price_min: fromNum(p.price_min), price_max: fromNum(p.price_max), price_confirmed: p.price_confirmed, is_active: p.is_active }), [p]);
  const save = useSave([['catalog']]);
  const dirty = f.price_min !== fromNum(p.price_min) || f.price_max !== fromNum(p.price_max) || f.price_confirmed !== p.price_confirmed || f.is_active !== p.is_active;
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const submit = (e) => {
    e.preventDefault();
    const min = toNum(f.price_min);
    save.mutate({ url: `/pricing/packages/${p.id}`, body: { price_min: min, price_max: toNum(f.price_max) ?? min, price_confirmed: f.price_confirmed, is_active: f.is_active } });
  };
  return (
    <li>
      <form onSubmit={submit} className="grid grid-cols-2 items-center gap-x-3 gap-y-2 px-2 py-3 md:grid-cols-[minmax(0,1fr)_100px_100px_90px_70px_70px]">
        <div className="col-span-2 min-w-0 md:col-span-1">
          <p className="flex flex-wrap items-center gap-2 font-bold">{p.name}{!p.price_confirmed && <Unconfirmed />}</p>
          <p className="truncate text-xs text-muted-foreground" title={p.folder_names.join(', ')}>
            {p.sendable_photos} photo{p.sendable_photos === 1 ? '' : 's'} · {p.unit_label ? `per ${p.unit_label} · ` : ''}Drive: {p.folder_names.join(', ') || '—'}
          </p>
        </div>
        <label className="text-xs md:text-sm"><span className="mb-1 block font-bold text-muted-foreground md:sr-only">From (₹)</span>
          <Input type="number" inputMode="numeric" min={0} step={100} value={f.price_min ?? ''} onChange={set('price_min')} disabled={!canWrite} aria-label={`${p.name} price from`} />
        </label>
        <label className="text-xs md:text-sm"><span className="mb-1 block font-bold text-muted-foreground md:sr-only">To (₹)</span>
          <Input type="number" inputMode="numeric" min={0} step={100} value={f.price_max ?? ''} onChange={set('price_max')} disabled={!canWrite} aria-label={`${p.name} price to`} />
        </label>
        <label className="flex items-center gap-2 text-xs font-bold text-muted-foreground"><Switch checked={!!f.price_confirmed} onCheckedChange={set('price_confirmed')} disabled={!canWrite} aria-label={`${p.name} price confirmed`} /><span className="md:sr-only">Confirmed</span></label>
        <label className="flex items-center gap-2 text-xs font-bold text-muted-foreground"><Switch checked={!!f.is_active} onCheckedChange={set('is_active')} disabled={!canWrite} aria-label={`${p.name} active`} /><span className="md:sr-only">Active</span></label>
        {canWrite && <Button type="submit" size="sm" disabled={!dirty || save.isPending} className="justify-self-start">Save</Button>}
      </form>
    </li>
  );
}

const RULE_TYPES = [['base_price', 'Price'], ['surcharge', 'Extra charge'], ['unit_price', 'Per piece']];

function RulesCard({ canWrite }) {
  const { data: catalog } = useCatalog();
  const opts = catalogOptions(catalog);
  const { data: rules = [] } = useQuery({ queryKey: ['pricing-rules'], queryFn: async () => (await api.get('/pricing/rules')).data.rules });
  const save = useSave([['pricing-rules']]);
  const blank = { package_id: null, theme_id: null, occasion_id: null, rule_type: 'base_price', price_min: '', price_max: '' };
  const [f, setF] = useState(blank);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const add = (e) => {
    e.preventDefault();
    const min = toNum(f.price_min);
    save.mutate({ method: 'post', url: '/pricing/rules', body: { ...f, price_min: min, price_max: toNum(f.price_max) ?? min } }, { onSuccess: () => setF(blank) });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Special prices</CardTitle>
        <CardDescription>A different price for one theme or occasion, e.g. baby shower ring frames. The most specific rule wins.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="divide-y rounded-lg border">
          {!rules.length && <li className="px-3 py-3 text-sm text-muted-foreground">No special prices.</li>}
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
              <span className="min-w-0 flex-1">
                <b>{r.package_name}</b>{r.theme_name ? ` · ${r.theme_name}` : ''}{r.occasion_name ? ` · ${r.occasion_name}` : ''}
                <span className="block text-xs text-muted-foreground">{RULE_TYPES.find(([k]) => k === r.rule_type)?.[1]}{r.notes ? ` · ${r.notes.replace(/^TODO\(client\):\s*/, '')}` : ''}</span>
              </span>
              <span className="font-bold">{priceRange(r.price_min, r.price_max)}</span>
              {!r.price_confirmed && <Unconfirmed />}
              {canWrite && (
                <Button size="icon-sm" variant="ghost" aria-label="Delete special price"
                  onClick={() => window.confirm('Delete this special price?') && save.mutate({ method: 'delete', url: `/pricing/rules/${r.id}` })}>
                  <Trash size={15} />
                </Button>
              )}
            </li>
          ))}
        </ul>
        {canWrite && (
          <form onSubmit={add} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1fr_0.9fr_0.8fr_0.8fr_auto]">
            <NativeSelect aria-label="Category" value={f.package_id} onChange={set('package_id')} options={opts.packages} placeholder="Category…" required />
            <NativeSelect aria-label="Theme" value={f.theme_id} onChange={set('theme_id')} options={opts.themes} placeholder="Any theme" />
            <NativeSelect aria-label="Occasion" value={f.occasion_id} onChange={set('occasion_id')} options={opts.occasions} placeholder="Any occasion" />
            <NativeSelect aria-label="Type" value={f.rule_type} onChange={set('rule_type')} options={RULE_TYPES} />
            <Input aria-label="Price from" type="number" min={0} step={100} placeholder="From ₹" value={f.price_min} onChange={set('price_min')} required />
            <Input aria-label="Price to" type="number" min={0} step={100} placeholder="To ₹" value={f.price_max} onChange={set('price_max')} />
            <Button type="submit" disabled={save.isPending || !f.package_id}><Plus size={15} /> Add</Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
