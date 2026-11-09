import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MapPin, Plus, Trash, Path } from '@phosphor-icons/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Field } from '@/pages/ai/fields';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { inr } from '@/lib/money';
import { useSave, toNum, fromNum, Hint, Unconfirmed } from './shared';

const TYPES = [['free', 'Free'], ['flat', 'Fixed charge'], ['per_km', '₹ per km'], ['not_serviceable', 'Not served']];

export default function DistanceTab() {
  const { can } = useAuth();
  const canWrite = can('pricing:write');
  const { data, isLoading } = useQuery({ queryKey: ['distance'], queryFn: async () => (await api.get('/pricing/distance')).data });
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <div className="space-y-4">
        <BaseCard base={data.base} canWrite={canWrite} roadDistance={data.road_distance} />
        <CheckCard />
      </div>
      <SlabsCard slabs={data.slabs} canWrite={canWrite} />
    </div>
  );
}

/** "https://maps.google.com/?q=17.49,78.35", ".../@17.49,78.35,17z" or "17.49, 78.35" -> {lat, lng} */
function parseCoords(text) {
  const m = /(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/.exec(text || '');
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
}

function BaseCard({ base, canWrite, roadDistance }) {
  const [f, setF] = useState(null);
  useEffect(() => setF({
    base_address: base?.base_address || '', base_lat: fromNum(base?.base_lat), base_lng: fromNum(base?.base_lng),
    road_factor: fromNum(base?.road_factor), max_service_km: fromNum(base?.max_service_km), paste: '',
  }), [base]);
  const save = useSave([['distance']], { success: 'Base location saved' });
  if (!f) return null;
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const pinSet = f.base_lat !== '' && f.base_lng !== '';
  const onPaste = (e) => {
    const v = e.target.value;
    const c = parseCoords(v);
    setF((x) => ({ ...x, paste: v, ...(c ? { base_lat: c.lat, base_lng: c.lng } : {}) }));
  };
  const submit = (e) => {
    e.preventDefault();
    save.mutate({ method: 'put', url: '/pricing/distance/base', body: {
      base_address: f.base_address || null, base_lat: toNum(f.base_lat), base_lng: toNum(f.base_lng),
      road_factor: Number(f.road_factor), max_service_km: toNum(f.max_service_km),
    } });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><MapPin size={18} /> Base location</CardTitle>
        <CardDescription>Where the team starts from (Miyapur). Distances to venues are measured from this pin.</CardDescription>
      </CardHeader>
      <CardContent>
        {!pinSet && <p className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-bold text-destructive">Not set yet: the bot can’t work out travel charges from a customer’s location until it is.</p>}
        <form onSubmit={submit} className="space-y-4">
          <fieldset disabled={!canWrite} className="space-y-4">
            <Field id="b-addr" label="Address"><Input id="b-addr" value={f.base_address} onChange={set('base_address')} /></Field>
            <Field id="b-paste" label="Paste a Google Maps link or coordinates" hint="In Google Maps, right-click the shop pin and copy the numbers, or share → copy link.">
              <Input id="b-paste" value={f.paste} onChange={onPaste} placeholder="17.4967, 78.3577" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field id="b-lat" label="Latitude"><Input id="b-lat" type="number" step="0.000001" min={-90} max={90} value={f.base_lat} onChange={set('base_lat')} /></Field>
              <Field id="b-lng" label="Longitude"><Input id="b-lng" type="number" step="0.000001" min={-180} max={180} value={f.base_lng} onChange={set('base_lng')} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field id="b-rf" label="Road factor" hint={roadDistance === 'google' ? 'Only used if Google Maps is unavailable' : 'Straight line × this ≈ road distance'}>
                <Input id="b-rf" type="number" step="0.05" min={1} max={3} value={f.road_factor} onChange={set('road_factor')} />
              </Field>
              <Field id="b-max" label="Furthest we go (km)" hint="Empty = use the distance bands"><Input id="b-max" type="number" min={1} step={1} value={f.max_service_km} onChange={set('max_service_km')} /></Field>
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            {canWrite && <Button type="submit" disabled={save.isPending || (f.base_lat === '') !== (f.base_lng === '')}>Save</Button>}
            {pinSet && <a className="text-sm font-bold text-primary hover:underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${f.base_lat},${f.base_lng}`}>Check the pin on Google Maps</a>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SlabsCard({ slabs, canWrite }) {
  const toRows = (list) => list.map((s) => ({ min_km: Number(s.min_km), max_km: fromNum(s.max_km), charge_type: s.charge_type, amount: fromNum(s.amount), label: s.label || '', price_confirmed: s.price_confirmed }));
  const [rows, setRows] = useState(() => toRows(slabs));
  useEffect(() => setRows(toRows(slabs)), [slabs]);
  const save = useSave([['distance']], { success: 'Distance charges saved' });
  const update = (i, k, v) => setRows((rs) => {
    const next = rs.map((r, j) => (j === i ? { ...r, [k]: v } : r));
    // keep bands joined: the next band starts where this one ends
    if (k === 'max_km' && next[i + 1]) next[i + 1] = { ...next[i + 1], min_km: v === '' ? next[i + 1].min_km : Number(v) };
    return next;
  });
  const addRow = () => setRows((rs) => {
    const last = rs[rs.length - 1];
    if (last && last.max_km === '') {
      const end = Number(last.min_km) + 10;
      return [...rs.slice(0, -1), { ...last, max_km: end }, { min_km: end, max_km: '', charge_type: 'not_serviceable', amount: '', label: '', price_confirmed: false }];
    }
    const start = last ? Number(last.max_km) : 0;
    return [...rs, { min_km: start, max_km: '', charge_type: 'flat', amount: '', label: '', price_confirmed: false }];
  });
  const removeRow = (i) => setRows((rs) => {
    const next = rs.filter((_, j) => j !== i);
    if (next[i] && i > 0) next[i] = { ...next[i], min_km: next[i - 1].max_km === '' ? next[i].min_km : Number(next[i - 1].max_km) };
    if (next[0]) next[0] = { ...next[0], min_km: 0 };
    return next;
  });
  const submit = (e) => {
    e.preventDefault();
    save.mutate({ method: 'put', url: '/pricing/distance/slabs', body: { slabs: rows.map((r) => ({
      min_km: Number(r.min_km), max_km: toNum(r.max_km), charge_type: r.charge_type, amount: r.charge_type === 'free' || r.charge_type === 'not_serviceable' ? 0 : Number(r.amount || 0),
      label: r.label.trim() || null, price_confirmed: !!r.price_confirmed,
    })) } });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Path size={18} /> Travel charge by distance {slabs.some((s) => !s.price_confirmed) && <Unconfirmed />}</CardTitle>
        <CardDescription>Road distance from the base. A band includes its start but not its end, so exactly 5 km falls in “5 to 10 km”.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="hidden grid-cols-[70px_80px_minmax(0,1fr)_100px_32px] gap-2 px-1 text-xs font-bold text-muted-foreground sm:grid">
            <span>From km</span><span>To km</span><span>Charge</span><span>Amount ₹</span><span />
          </div>
          <ol className="space-y-2">
            {rows.map((r, i) => (
              <li key={i} className="grid grid-cols-[70px_80px_minmax(0,1fr)] gap-2 rounded-lg border p-2 sm:grid-cols-[70px_80px_minmax(0,1fr)_100px_32px] sm:border-0 sm:p-0">
                <Input aria-label={`Band ${i + 1} from km`} value={r.min_km} readOnly tabIndex={-1} className="bg-muted/60" />
                <Input aria-label={`Band ${i + 1} to km`} type="number" min={0} step={0.5} placeholder="no limit" value={r.max_km} disabled={!canWrite} onChange={(e) => update(i, 'max_km', e.target.value)} />
                <NativeSelect aria-label={`Band ${i + 1} charge`} value={r.charge_type} disabled={!canWrite} onChange={(v) => update(i, 'charge_type', v)} options={TYPES} />
                <Input aria-label={`Band ${i + 1} amount`} type="number" min={0} step={10} className="col-span-2 sm:col-span-1"
                  placeholder={r.charge_type === 'per_km' ? '₹ per km' : '₹'} value={r.charge_type === 'free' || r.charge_type === 'not_serviceable' ? '' : r.amount}
                  disabled={!canWrite || r.charge_type === 'free' || r.charge_type === 'not_serviceable'} onChange={(e) => update(i, 'amount', e.target.value)} />
                {canWrite && rows.length > 1 ? (
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove band ${i + 1}`} onClick={() => removeRow(i)} className="self-center justify-self-end"><Trash size={15} /></Button>
                ) : <span />}
              </li>
            ))}
          </ol>
          <ul className="space-y-0.5 text-sm text-muted-foreground">
            {rows.map((r, i) => (
              <li key={i}>
                {r.max_km === '' ? `${r.min_km} km and more` : `${r.min_km} to ${r.max_km} km`}: {' '}
                <b className="text-foreground">{r.charge_type === 'free' ? 'free' : r.charge_type === 'flat' ? inr(r.amount || 0) : r.charge_type === 'per_km' ? `${inr(r.amount || 0)} for each km after ${r.min_km} km` : 'the bot hands over to the team'}</b>
              </li>
            ))}
          </ul>
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={save.isPending}>Save distance charges</Button>
              <Button type="button" variant="outline" onClick={addRow}><Plus size={15} /> Add band</Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function CheckCard() {
  const [km, setKm] = useState('');
  const check = useMutation({
    mutationFn: async () => (await api.post('/pricing/distance/check', { km: Number(km) })).data,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const r = check.data;
  return (
    <Card>
      <CardHeader><CardTitle>Check a distance</CardTitle></CardHeader>
      <CardContent>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); check.mutate(); }}>
          <Input type="number" min={0} step={0.1} value={km} onChange={(e) => setKm(e.target.value)} placeholder="km" aria-label="Distance in km" className="w-28" />
          <Button type="submit" variant="outline" disabled={km === '' || check.isPending}>Check</Button>
        </form>
        {r && (
          <p className="mt-3 text-sm" aria-live="polite">
            {r.km} km: {r.serviceable ? <b>{r.charge ? inr(r.charge) : 'free'}</b> : <b className="text-destructive">outside the service area (team decides)</b>}
            {r.label ? ` · ${r.label}` : ''}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
