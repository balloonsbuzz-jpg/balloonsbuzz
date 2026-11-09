import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Storefront, Clock, CurrencyInr } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Field, ChipsInput } from '@/pages/ai/fields';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';

const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];

export default function BusinessSettings() {
  const { can } = useAuth();
  const canWrite = can('settings:write');
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['business'], queryFn: async () => (await api.get('/settings/business')).data.business });
  const [f, setF] = useState(null);
  useEffect(() => {
    if (!data) return;
    setF({
      business_name: data.business_name, base_address: data.base_address || '',
      advance_type: data.advance_type, advance_value: data.advance_value == null ? '' : Number(data.advance_value),
      min_lead_time_hours: data.min_lead_time_hours, max_bookings_per_day: data.max_bookings_per_day ?? '',
      working_hours: data.working_hours || {}, staff_alert_phones: data.staff_alert_phones || [],
      upi_vpa: data.upi_vpa || '', upi_payee_name: data.upi_payee_name || '',
    });
  }, [data]);
  const save = useMutation({
    mutationFn: async () => (await api.put('/settings/business', {
      business_name: f.business_name.trim(), base_address: f.base_address.trim() || null,
      advance_type: f.advance_type, advance_value: f.advance_value === '' ? null : Number(f.advance_value),
      min_lead_time_hours: Number(f.min_lead_time_hours), max_bookings_per_day: f.max_bookings_per_day === '' ? null : Number(f.max_bookings_per_day),
      working_hours: f.working_hours, staff_alert_phones: f.staff_alert_phones,
      upi_vpa: f.upi_vpa.trim() || null, upi_payee_name: f.upi_payee_name.trim() || null,
    })).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['business'] }); toast.success('Business details saved'); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (isLoading || !f) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const setHours = (day, idx, val) => setF((x) => {
    const cur = x.working_hours[day]?.[0] || ['09:00', '21:00'];
    const next = [...cur]; next[idx] = val;
    return { ...x, working_hours: { ...x.working_hours, [day]: [next] } };
  });
  const toggleDay = (day, open) => setF((x) => ({ ...x, working_hours: { ...x.working_hours, [day]: open ? [['09:00', '21:00']] : [] } }));

  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <fieldset disabled={!canWrite} className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Storefront size={18} /> Business</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <Field id="bs-name" label="Business name"><Input id="bs-name" value={f.business_name} onChange={set('business_name')} required /></Field>
            <Field id="bs-addr" label="Address" hint={<>The map pin for travel charges is in <Link to="/pricing" className="font-bold text-primary">Pricing & Rules → Distance</Link>.</>}>
              <Input id="bs-addr" value={f.base_address} onChange={set('base_address')} />
            </Field>
            <Field id="bs-staff" label="Team phones for alerts" hint="WhatsApp numbers that get a message when a chat needs a person">
              <ChipsInput id="bs-staff" value={f.staff_alert_phones} onChange={set('staff_alert_phones')} placeholder="919392534625, then Enter" />
            </Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><CurrencyInr size={18} /> Bookings and payment</CardTitle>
            <CardDescription>Used when bookings arrive (M7).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field id="bs-adv-type" label="Advance"><NativeSelect id="bs-adv-type" value={f.advance_type} onChange={set('advance_type')} options={[['percent', '% of the price'], ['fixed', 'Fixed ₹']]} /></Field>
              <Field id="bs-adv" label={f.advance_type === 'percent' ? 'Advance %' : 'Advance ₹'}><Input id="bs-adv" type="number" min={0} max={f.advance_type === 'percent' ? 100 : undefined} value={f.advance_value} onChange={set('advance_value')} placeholder="not set" /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field id="bs-lead" label="Book at least (hours ahead)"><Input id="bs-lead" type="number" min={0} value={f.min_lead_time_hours} onChange={set('min_lead_time_hours')} /></Field>
              <Field id="bs-cap" label="Most events per day"><Input id="bs-cap" type="number" min={1} value={f.max_bookings_per_day} onChange={set('max_bookings_per_day')} placeholder="no limit" /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field id="bs-upi" label="UPI ID"><Input id="bs-upi" value={f.upi_vpa} onChange={set('upi_vpa')} placeholder="balloonsbuzz@okhdfc" /></Field>
              <Field id="bs-payee" label="UPI name"><Input id="bs-payee" value={f.upi_payee_name} onChange={set('upi_payee_name')} placeholder="BalloonsBuzz" /></Field>
            </div>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Clock size={18} /> Working hours</CardTitle>
            <CardDescription>Outside these hours the bot still replies, but tells customers the team will confirm the next morning.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2 sm:grid-cols-2">
              {DAYS.map(([d, label]) => {
                const slot = f.working_hours[d]?.[0];
                return (
                  <li key={d} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
                    <label className="flex w-32 items-center gap-2 text-sm font-bold">
                      <input type="checkbox" className="accent-[var(--primary)]" checked={!!slot} onChange={(e) => toggleDay(d, e.target.checked)} /> {label}
                    </label>
                    {slot ? (
                      <span className="flex items-center gap-1.5 text-sm">
                        <Input type="time" aria-label={`${label} opens`} value={slot[0]} onChange={(e) => setHours(d, 0, e.target.value)} className="w-28" />
                        to
                        <Input type="time" aria-label={`${label} closes`} value={slot[1]} onChange={(e) => setHours(d, 1, e.target.value)} className="w-28" />
                      </span>
                    ) : <span className="text-sm text-muted-foreground">Closed</span>}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      </fieldset>
      {canWrite && <Button type="submit" size="lg" className="mt-4" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save business details'}</Button>}
    </form>
  );
}
