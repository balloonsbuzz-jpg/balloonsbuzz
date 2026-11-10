import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { ArrowsClockwise, PaperPlaneTilt, Info } from '@phosphor-icons/react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

const STATUS = {
  approved: ['Approved', 'bg-success/15 text-success'], pending: ['Waiting for Meta', 'bg-accent text-accent-foreground'],
  rejected: ['Rejected', 'bg-destructive/10 text-destructive'], paused: ['Paused by Meta', 'bg-accent text-accent-foreground'],
  disabled: ['Disabled', 'bg-muted text-muted-foreground'], draft: ['Draft', 'bg-muted text-muted-foreground'],
};
export const PURPOSE_LABEL = {
  booking_confirmation: 'Booking confirmation', advance_reminder: 'Advance reminder', event_reminder: 'Event reminder (day before)',
  review_request: 'Review request', quote_followup: 'Quote follow-up', handover_alert: 'Team alert (chat needs a person)', broadcast: 'Broadcasts / offers',
};

export function useTemplates() {
  return useQuery({ queryKey: ['templates'], queryFn: async () => (await api.get('/templates')).data });
}

export default function TemplatesPage() {
  const { can } = useAuth();
  const canWrite = can('templates:write');
  const qc = useQueryClient();
  const { data, isLoading } = useTemplates();
  const sync = useMutation({
    mutationFn: async () => (await api.post('/templates/sync')).data,
    onSuccess: (r) => { qc.setQueryData(['templates'], (d) => ({ ...d, templates: r.templates })); toast.success(`Synced ${r.total} templates from Meta (${r.added} new)`); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const submit = useMutation({
    mutationFn: async (name) => (await api.post(`/templates/recommended/${name}`)).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['templates'] }); toast.success('Sent to Meta for approval. It usually takes a few minutes to a day.'); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const list = data?.templates || [];
  const lastSync = list.map((t) => t.last_synced_at).filter(Boolean).sort().at(-1);
  const missing = (data?.recommended || []).filter((r) => !list.some((t) => t.name === r.name));

  return (
    <>
      <PageHeader
        title="Templates"
        description="WhatsApp only lets businesses start a conversation (or message after 24 hours of silence) with templates approved by Meta. They power broadcasts, reminders and confirmations."
        actions={canWrite && <Button variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}><ArrowsClockwise size={16} className={cn(sync.isPending && 'animate-spin')} /> Sync from Meta</Button>}
      />
      {lastSync && <p className="-mt-3 mb-4 text-xs text-muted-foreground">Last synced {formatDistanceToNow(new Date(lastSync), { addSuffix: true })}</p>}
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {missing.length > 0 && canWrite && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-extrabold">Recommended for BalloonsBuzz</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {missing.map((r) => (
              <div key={r.name} className="rounded-xl border border-dashed bg-card p-4">
                <p className="text-sm font-bold">{PURPOSE_LABEL[r.purpose]} <span className="font-mono text-xs font-normal text-muted-foreground">{r.name}</span></p>
                <p className="mt-2 rounded-lg bg-[#d9fdd3] px-3 py-2 text-[13px] whitespace-pre-line text-[#111b21] dark:bg-[#005c4b] dark:text-[#e9edef]">{r.body}</p>
                <Button size="sm" className="mt-3" onClick={() => submit.mutate(r.name)} disabled={submit.isPending}><PaperPlaneTilt size={14} /> Submit to Meta</Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {!isLoading && !list.length && (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No templates yet. Press “Sync from Meta”, or submit the recommended ones above.</p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {list.map((t) => <TemplateCard key={t.id} t={t} variables={data.variables} purposes={data.purposes} canWrite={canWrite} />)}
      </div>
    </>
  );
}

function TemplateCard({ t, variables, purposes, canWrite }) {
  const qc = useQueryClient();
  const [purpose, setPurpose] = useState(t.purpose || '');
  const [map, setMap] = useState(t.variable_map || {});
  useEffect(() => { setPurpose(t.purpose || ''); setMap(t.variable_map || {}); }, [t]);
  const save = useMutation({
    mutationFn: async () => (await api.patch(`/templates/${t.id}`, { purpose: purpose || null, variable_map: map })).data.template,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['templates'] }); toast.success('Template settings saved'); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const body = (t.components || []).find((c) => c.type === 'BODY')?.text || '';
  const [label, tone] = STATUS[t.status] || [t.status, ''];
  const dirty = (purpose || null) !== (t.purpose || null) || JSON.stringify(map) !== JSON.stringify(t.variable_map || {});
  const vars = variables.filter((v) => purpose === 'broadcast' || v.key !== 'static');
  return (
    <article className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-mono text-sm font-bold">{t.name}</p>
        <span className="text-xs text-muted-foreground">{t.language} · {t.category.toLowerCase()}</span>
        <span className={cn('ml-auto rounded-full px-2 py-0.5 text-[11px] font-bold', tone)}>{label}</span>
      </div>
      {t.rejected_reason && <p className="mt-1 text-xs text-destructive">Meta: {t.rejected_reason}</p>}
      <p className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-[13px] whitespace-pre-line">{body || <i>No body text</i>}</p>
      <div className="mt-3 space-y-2">
        <label className="flex items-center gap-2 text-sm"><span className="w-28 shrink-0 font-bold">Used for</span>
          <NativeSelect className="flex-1" value={purpose} onChange={(v) => setPurpose(v || '')} disabled={!canWrite}
            options={purposes.map((p) => [p, PURPOSE_LABEL[p] || p])} placeholder="Not used automatically" aria-label={`${t.name} used for`} />
        </label>
        {t.placeholders.map((n) => (
          <label key={n} className="flex items-center gap-2 text-sm"><span className="w-28 shrink-0 font-mono font-bold">{`{{${n}}}`}</span>
            <NativeSelect className="flex-1" value={map[n] || ''} disabled={!canWrite} aria-label={`${t.name} placeholder ${n}`}
              onChange={(v) => setMap((m) => { const x = { ...m }; if (v) x[n] = v; else delete x[n]; return x; })}
              options={vars.map((v) => [v.key, v.label])} placeholder="Choose what fills it…" />
          </label>
        ))}
        {t.placeholders.some((n) => !map[n]) && <p className="flex items-center gap-1 text-xs text-muted-foreground"><Info size={13} /> Every {'{{n}}'} needs a field before this template can be used.</p>}
      </div>
      {canWrite && <Button size="sm" className="mt-3" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Save</Button>}
    </article>
  );
}
