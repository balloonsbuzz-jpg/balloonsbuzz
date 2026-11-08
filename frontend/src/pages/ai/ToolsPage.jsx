import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Lock, ArrowCounterClockwise, CaretDown } from '@phosphor-icons/react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { Field } from './fields';

// Friendly labels for per-tool settings (keys come from the server's tool catalog).
const CONFIG_LABELS = {
  default_count: ['Photos per reply', 'How many photos to send when the customer does not say'],
  max_count: ['Maximum photos per reply', 'Hard cap (WhatsApp-friendly: 5)'],
  budget_upsell_pct: ['Allow above budget by', '% above the budget the bot may still suggest'],
  spread_across_packages: ['Mix design types', 'e.g. one single frame, one 2-frame, one ring frame within budget'],
  default_prompt_text: ['Button message', 'Text shown with the "share location" button'],
  max_days_ahead: ['Furthest follow-up', 'days ahead'],
  quiet_hours: ['Quiet hours', 'No follow-ups between these times (IST)'],
};

function useTools() {
  return useQuery({ queryKey: ['agent-tools'], queryFn: async () => (await api.get('/agent/tools')).data.tools });
}

function useToolMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, body, reset }) => (reset
      ? (await api.post(`/agent/tools/${name}/reset`)).data.tool
      : (await api.patch(`/agent/tools/${name}`, body)).data.tool),
    onSuccess: (tool) => {
      qc.setQueryData(['agent-tools'], (list = []) => list.map((t) => (t.name === tool.name ? tool : t)));
      toast.success(`${tool.display_name} updated`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

export default function ToolsPage() {
  const { can } = useAuth();
  const { data: tools = [], isLoading } = useTools();
  return (
    <>
      <PageHeader
        title="Tools"
        description="Actions the assistant can take. Edit the description to change WHEN the AI uses a tool; switch tools on or off; tune their settings."
      />
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <div className="space-y-3">
        {tools.map((t) => <ToolCard key={t.name} tool={t} canWrite={can('agent:write')} />)}
      </div>
    </>
  );
}

function ToolCard({ tool, canWrite }) {
  const m = useToolMutation();
  const [description, setDescription] = useState(tool.description);
  const [config, setConfig] = useState(tool.config);
  const [open, setOpen] = useState(false);
  useEffect(() => { setDescription(tool.description); setConfig(tool.config); }, [tool]);

  const descDirty = description.trim() !== tool.description;
  const configDirty = JSON.stringify(config) !== JSON.stringify(tool.config);
  const hasConfig = Object.keys(tool.config || {}).length > 0;
  const params = Object.entries(tool.parameters?.properties || {});

  return (
    <Card className={cn('py-0', !tool.is_enabled && 'opacity-70')}>
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-expanded={open}>
            <CaretDown size={16} className={cn('shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')} />
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-extrabold">
                {tool.display_name}
                {tool.is_required && <span className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-px text-[11px] font-bold text-accent-foreground"><Lock size={11} weight="bold" /> Locked on</span>}
                {tool.is_customised && <span className="rounded-full bg-secondary px-2 py-px text-[11px] font-bold text-secondary-foreground">Edited</span>}
              </p>
              <p className="truncate font-mono text-xs text-muted-foreground">{tool.name}</p>
            </div>
          </button>
          <Switch
            checked={tool.is_enabled}
            disabled={!canWrite || tool.is_required || m.isPending}
            onCheckedChange={(v) => m.mutate({ name: tool.name, body: { is_enabled: v } })}
            aria-label={`${tool.display_name} on/off`}
            title={tool.is_required ? 'Needed for price safety and handover' : undefined}
          />
        </div>

        {open && (
          <div className="mt-4 space-y-5 border-t pt-4">
            <Field id={`desc-${tool.name}`} label="What the AI reads" hint="Be specific about when to use it and when not to.">
              <Textarea id={`desc-${tool.name}`} rows={4} value={description} readOnly={!canWrite} maxLength={2000}
                onChange={(e) => setDescription(e.target.value)} />
            </Field>
            {canWrite && (
              <div className="flex flex-wrap gap-2">
                <Button disabled={!descDirty || description.trim().length < 10 || m.isPending}
                  onClick={() => m.mutate({ name: tool.name, body: { description } })}>Save description</Button>
                {descDirty && <Button variant="outline" onClick={() => setDescription(tool.description)}>Undo</Button>}
                {tool.is_customised && (
                  <Button variant="ghost" onClick={() => m.mutate({ name: tool.name, reset: true })}>
                    <ArrowCounterClockwise size={15} /> Reset to default
                  </Button>
                )}
              </div>
            )}

            {hasConfig && (
              <div className="rounded-xl border p-4">
                <p className="mb-3 text-sm font-extrabold">Settings</p>
                <fieldset disabled={!canWrite} className="grid gap-4 sm:grid-cols-2">
                  {Object.entries(config).map(([k, v]) => (
                    <ConfigField key={k} name={k} value={v} onChange={(nv) => setConfig((c) => ({ ...c, [k]: nv }))} />
                  ))}
                </fieldset>
                {canWrite && configDirty && (
                  <div className="mt-4 flex gap-2">
                    <Button disabled={m.isPending} onClick={() => m.mutate({ name: tool.name, body: { config } })}>Save settings</Button>
                    <Button variant="outline" onClick={() => setConfig(tool.config)}>Undo</Button>
                  </div>
                )}
              </div>
            )}

            {params.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer font-bold text-muted-foreground">Details the AI can pass ({params.length})</summary>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {params.map(([p, s]) => (
                    <li key={p} className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs">
                      {p}{tool.parameters.required?.includes(p) ? '*' : ''}<span className="text-muted-foreground">: {s.type}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ConfigField({ name, value, onChange }) {
  const [label, hint] = CONFIG_LABELS[name] || [name, undefined];
  const id = `cfg-${name}`;
  if (typeof value === 'boolean') {
    return (
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-sm font-bold">{label}</p>{hint && <p className="text-xs text-muted-foreground">{hint}</p>}</div>
        <Switch checked={value} onCheckedChange={onChange} aria-label={label} />
      </div>
    );
  }
  if (Array.isArray(value) && value.length === 2) {
    return (
      <Field id={id} label={label} hint={hint}>
        <div className="flex items-center gap-2">
          <Input id={id} type="time" value={value[0]} onChange={(e) => onChange([e.target.value, value[1]])} className="max-w-32" />
          <span className="text-sm text-muted-foreground">to</span>
          <Input type="time" aria-label={`${label} end`} value={value[1]} onChange={(e) => onChange([value[0], e.target.value])} className="max-w-32" />
        </div>
      </Field>
    );
  }
  if (typeof value === 'number') {
    return (
      <Field id={id} label={label} hint={hint}>
        <Input id={id} type="number" value={value} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} className="max-w-32" />
      </Field>
    );
  }
  return (
    <Field id={id} label={label} hint={hint} className="sm:col-span-2">
      <Input id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}
