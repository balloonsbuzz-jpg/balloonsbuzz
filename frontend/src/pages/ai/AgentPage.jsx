import { useEffect, useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { ArrowCounterClockwise, Key, Robot, ChatCircleDots, Warning, CheckCircle } from '@phosphor-icons/react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/hooks/useAuth';
import { diffLines } from '@/lib/diff';
import { cn } from '@/lib/utils';
import { Field, NumberField, ChipsInput } from './fields';
import {
  useAgentConfig, useSaveConfig, useVersions, useVersion, useRestoreVersion, useSetApiKey, useClearApiKey,
} from './useAgentConfig';

const EDITABLE = [
  'is_enabled', 'provider', 'model', 'base_url', 'fallback_model', 'system_prompt', 'temperature',
  'max_output_tokens', 'max_tool_iterations', 'max_history_messages', 'summary_every_messages',
  'max_message_chars', 'max_messages_per_turn', 'response_delay_min_ms', 'response_delay_max_ms',
  'stuck_threshold', 'handover_keywords', 'handover_message', 'out_of_hours_message', 'pricing_per_1m',
];
const PROVIDERS = [
  ['deepseek', 'DeepSeek'], ['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['gemini', 'Google Gemini'],
  ['groq', 'Groq'], ['openrouter', 'OpenRouter'], ['custom', 'Custom (OpenAI-compatible)'],
];
const MODEL_SUGGESTIONS = { deepseek: ['deepseek-chat', 'deepseek-reasoner'] };

const pick = (cfg) => Object.fromEntries(EDITABLE.map((k) => [k, cfg[k]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export default function AgentPage() {
  const { can } = useAuth();
  const canWrite = can('agent:write');
  const { data: config, isLoading, error } = useAgentConfig();
  const save = useSaveConfig();
  const [draft, setDraft] = useState(null);
  const [note, setNote] = useState('');
  const [tab, setTab] = useState('prompt');

  useEffect(() => { if (config) setDraft(pick(config)); }, [config]);

  const dirtyKeys = useMemo(
    () => (config && draft ? EDITABLE.filter((k) => !same(draft[k], config[k])) : []),
    [config, draft],
  );
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));

  if (isLoading || !draft) return <PageHeader title="AI Agent" description="Loading…" />;
  if (error) return <PageHeader title="AI Agent" description="Could not load the agent settings." />;

  function onSave() {
    const body = { version: config.version, ...(note.trim() ? { change_note: note.trim() } : {}) };
    for (const k of dirtyKeys) body[k] = draft[k];
    save.mutate(body, { onSuccess: () => setNote('') });
  }

  return (
    <div className={cn(dirtyKeys.length && 'pb-24')}>
      <PageHeader
        title="AI Agent"
        description="The WhatsApp sales assistant: what it says (prompt), which AI model it uses, and how it behaves."
        actions={(
          <label className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2">
            <span className="text-sm font-bold">{draft.is_enabled ? 'Bot is ON' : 'Bot is OFF'}</span>
            <Switch checked={draft.is_enabled} disabled={!canWrite} onCheckedChange={set('is_enabled')} aria-label="Bot on/off" />
          </label>
        )}
      />

      {!config.system_prompt || config.system_prompt.startsWith('PLACEHOLDER') ? (
        <Notice tone="warning">The prompt is still a placeholder. The full BalloonsBuzz sales prompt is written in Phase 4 and can be edited here afterwards.</Notice>
      ) : null}
      {config.api_key_source === 'none' && (
        <Notice tone="warning">No API key is configured for {config.provider}. Add <code className="font-mono">{config.env_key_name || 'an API key'}</code> to the server .env, or save a key under “Model & API key”.</Notice>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 w-full max-w-xl">
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
          <TabsTrigger value="model">Model & API key</TabsTrigger>
          <TabsTrigger value="behaviour">Behaviour</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="prompt"><PromptTab draft={draft} set={set} canWrite={canWrite} /></TabsContent>
        <TabsContent value="model"><ModelTab draft={draft} set={set} config={config} canWrite={canWrite} /></TabsContent>
        <TabsContent value="behaviour"><BehaviourTab draft={draft} set={set} canWrite={canWrite} /></TabsContent>
        <TabsContent value="history"><HistoryTab config={config} canWrite={canWrite} dirty={dirtyKeys.length > 0} /></TabsContent>
      </Tabs>

      {dirtyKeys.length > 0 && canWrite && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 backdrop-blur lg:pl-64">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
            <p className="text-sm font-bold">{dirtyKeys.length} unsaved change{dirtyKeys.length > 1 ? 's' : ''}</p>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed? (optional, shown in History)" className="h-9 max-w-sm flex-1" maxLength={300} />
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="lg" onClick={() => setDraft(pick(config))}>Discard</Button>
              <Button size="lg" onClick={onSave} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Notice({ tone = 'info', children }) {
  return (
    <div className={cn('mb-4 flex items-start gap-2 rounded-xl border px-4 py-3 text-sm',
      tone === 'warning' ? 'border-warning/30 bg-warning/10 text-warning' : 'border-primary/20 bg-primary/5')}>
      <Warning size={18} className="mt-0.5 shrink-0" />
      <div className="text-foreground">{children}</div>
    </div>
  );
}

function PromptTab({ draft, set, canWrite }) {
  const chars = draft.system_prompt?.length || 0;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
      <Card>
        <CardHeader>
          <CardTitle>System prompt</CardTitle>
          <CardDescription>The instructions the assistant follows in every chat. Prices must come from the pricing tools, never from this text.</CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            aria-label="System prompt"
            value={draft.system_prompt}
            readOnly={!canWrite}
            onChange={(e) => set('system_prompt')(e.target.value)}
            className="min-h-[460px] font-mono text-[13px] leading-relaxed"
            spellCheck={false}
          />
          <p className={cn('mt-2 text-right text-xs', chars > 50000 ? 'text-destructive' : 'text-muted-foreground')}>{chars.toLocaleString()} / 50,000 characters</p>
        </CardContent>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ChatCircleDots size={18} /> Writing tips</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>Keep replies short and sweet. The bot also splits anything longer than the max message length.</p>
            <p>Tell it to collect occasion, theme, date, venue, guests and budget.</p>
            <p>Never put prices here. The bot gets them from <b>Get pricing</b> and the gallery photos.</p>
            <p>Every save is kept under <b>History</b>, so you can undo any change.</p>
          </CardContent>
        </Card>
        <Card className="border-dashed">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Robot size={18} /> Test console</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Chat with the bot from here and watch its tool calls. Arrives with the AI runtime (M6).
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ModelTab({ draft, set, config, canWrite }) {
  const suggestions = MODEL_SUGGESTIONS[draft.provider] || [];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Model</CardTitle>
          <CardDescription>DeepSeek is the default, as in Whapter.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field id="provider" label="Provider">
            <Select value={draft.provider} onValueChange={set('provider')} disabled={!canWrite}>
              <SelectTrigger id="provider" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{PROVIDERS.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field id="model" label="Model" hint={suggestions.length ? `Suggested: ${suggestions.join(', ')}` : undefined}>
            <Input id="model" list="model-suggestions" value={draft.model} readOnly={!canWrite} onChange={(e) => set('model')(e.target.value)} />
            <datalist id="model-suggestions">{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
          </Field>
          <Field id="fallback_model" label="Fallback model" hint="Tried once if the main model errors. Leave empty to disable.">
            <Input id="fallback_model" list="model-suggestions" value={draft.fallback_model || ''} readOnly={!canWrite} onChange={(e) => set('fallback_model')(e.target.value || null)} />
          </Field>
          <Field id="base_url" label="Custom base URL" hint="Only for self-hosted or OpenAI-compatible endpoints. Leave empty for the provider default.">
            <Input id="base_url" placeholder="https://api.deepseek.com" value={draft.base_url || ''} readOnly={!canWrite} onChange={(e) => set('base_url')(e.target.value || null)} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <NumberField id="temperature" label="Temperature" hint="Lower = more consistent" value={draft.temperature} onChange={set('temperature')} min={0} max={2} step={0.1} />
            <NumberField id="max_output_tokens" label="Max reply tokens" value={draft.max_output_tokens} onChange={set('max_output_tokens')} min={50} max={8000} step={50} />
          </div>
        </CardContent>
      </Card>
      <div className="space-y-4">
        <ApiKeyCard config={config} canWrite={canWrite} />
        <Card>
          <CardHeader>
            <CardTitle>Cost tracking</CardTitle>
            <CardDescription>Price per 1 million tokens, used for the AI cost numbers in Analytics.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-3">
            {['input', 'cached_input', 'output'].map((k) => (
              <NumberField key={k} id={`price-${k}`} label={k === 'cached_input' ? 'Cached input' : k[0].toUpperCase() + k.slice(1)}
                value={draft.pricing_per_1m?.[k] ?? 0} min={0} step={0.01}
                onChange={(v) => set('pricing_per_1m')({ currency: 'USD', input: 0, cached_input: 0, output: 0, ...draft.pricing_per_1m, [k]: v })} />
            ))}
            <p className="col-span-3 text-xs text-muted-foreground">Currency: {draft.pricing_per_1m?.currency || 'USD'}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ApiKeyCard({ config, canWrite }) {
  const setKey = useSetApiKey();
  const clearKey = useClearApiKey();
  const [value, setValue] = useState('');
  const source = config.api_key_source;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Key size={18} /> API key</CardTitle>
        <CardDescription>Keys are stored encrypted and never shown again after saving.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
          {source === 'none' ? <Warning size={18} className="text-warning" /> : <CheckCircle size={18} className="text-success" weight="fill" />}
          {source === 'ui' && <span>Using the key saved here (••••{config.api_key_last4})</span>}
          {source === 'env' && <span>Using <code className="font-mono">{config.env_key_name}</code> from the server .env</span>}
          {source === 'none' && <span>No key found for {config.provider}</span>}
        </div>
        {canWrite && (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setKey.mutate(value, { onSuccess: () => setValue('') }); }}>
            <Input type="password" autoComplete="off" placeholder="Paste a new key to override" value={value} onChange={(e) => setValue(e.target.value)} />
            <Button type="submit" size="lg" disabled={value.trim().length < 10 || setKey.isPending}>Save key</Button>
          </form>
        )}
        {canWrite && source === 'ui' && (
          <Button variant="outline" onClick={() => clearKey.mutate()} disabled={clearKey.isPending}>
            Remove saved key{config.env_key_name ? ` (fall back to ${config.env_key_name})` : ''}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function BehaviourTab({ draft, set, canWrite }) {
  const delayInvalid = draft.response_delay_max_ms < draft.response_delay_min_ms;
  return (
    <fieldset disabled={!canWrite} className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Short and sweet replies</CardTitle><CardDescription>Keeps messages WhatsApp-sized.</CardDescription></CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <NumberField id="max_message_chars" label="Max message length" suffix="chars" value={draft.max_message_chars} onChange={set('max_message_chars')} min={50} max={4096} />
          <NumberField id="max_messages_per_turn" label="Max messages per reply" value={draft.max_messages_per_turn} onChange={set('max_messages_per_turn')} min={1} max={10} />
          <NumberField id="response_delay_min_ms" label="Typing delay from" suffix="ms" value={draft.response_delay_min_ms} onChange={set('response_delay_min_ms')} min={0} max={30000} step={250} />
          <Field id="response_delay_max_ms" label="Typing delay to" error={delayInvalid ? 'Must be at least the “from” delay' : undefined}>
            <div className="flex items-center gap-2">
              <Input id="response_delay_max_ms" type="number" min={0} max={60000} step={250} className="max-w-36"
                value={draft.response_delay_max_ms} onChange={(e) => set('response_delay_max_ms')(Number(e.target.value))} />
              <span className="text-sm text-muted-foreground">ms</span>
            </div>
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Memory & reasoning</CardTitle><CardDescription>How much of the chat the bot reads, and its limits per turn.</CardDescription></CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <NumberField id="max_history_messages" label="Recent messages read" value={draft.max_history_messages} onChange={set('max_history_messages')} min={1} max={200} />
          <NumberField id="summary_every_messages" label="Summarise every" suffix="messages" value={draft.summary_every_messages} onChange={set('summary_every_messages')} min={1} max={500} />
          <NumberField id="max_tool_iterations" label="Max tool calls per reply" value={draft.max_tool_iterations} onChange={set('max_tool_iterations')} min={1} max={20} />
          <NumberField id="stuck_threshold" label="Hand over after" suffix="confused turns" value={draft.stuck_threshold} onChange={set('stuck_threshold')} min={1} max={20} />
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>Handover to a human</CardTitle><CardDescription>When these words appear, the bot pauses and the team is alerted.</CardDescription></CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <Field id="handover_keywords" label="Handover keywords" hint="Press Enter to add. Matched case-insensitively." className="lg:col-span-2">
            <ChipsInput id="handover_keywords" value={draft.handover_keywords} onChange={set('handover_keywords')} placeholder="e.g. call me" />
          </Field>
          <Field id="handover_message" label="Message sent on handover">
            <Textarea id="handover_message" rows={3} maxLength={1000} value={draft.handover_message || ''} onChange={(e) => set('handover_message')(e.target.value)} />
          </Field>
          <Field id="out_of_hours_message" label="Out-of-hours message">
            <Textarea id="out_of_hours_message" rows={3} maxLength={1000} value={draft.out_of_hours_message || ''} onChange={(e) => set('out_of_hours_message')(e.target.value)} />
          </Field>
        </CardContent>
      </Card>
    </fieldset>
  );
}

function HistoryTab({ config, canWrite, dirty }) {
  const { data: versions = [], isLoading } = useVersions();
  const [viewing, setViewing] = useState(null);
  const restore = useRestoreVersion();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Version history</CardTitle>
        <CardDescription>Every save is a version. Restoring creates a new version, so nothing is lost.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!isLoading && versions.length === 0 && <p className="text-sm text-muted-foreground">No saved versions yet. The first save records the original settings too.</p>}
        <ul className="divide-y">
          {versions.map((v) => (
            <li key={v.version} className="flex flex-wrap items-center gap-3 py-3">
              <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-extrabold', v.version === config.version ? 'bg-primary text-primary-foreground' : 'bg-muted')}>
                v{v.version}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{v.change_note || 'No note'}</p>
                <p className="text-xs text-muted-foreground">
                  {v.created_by_name || 'System'} · {formatDistanceToNow(new Date(v.created_at), { addSuffix: true })} · {v.model} · {Number(v.prompt_chars).toLocaleString()} chars
                </p>
              </div>
              <Button variant="outline" onClick={() => setViewing(v.version)}>View & compare</Button>
              {canWrite && v.version !== config.version && (
                <Button variant="secondary" disabled={restore.isPending || dirty} title={dirty ? 'Save or discard your changes first' : undefined}
                  onClick={() => restore.mutate(v.version)}>
                  <ArrowCounterClockwise size={16} /> Restore
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
      <VersionDialog version={viewing} current={config} onClose={() => setViewing(null)} />
    </Card>
  );
}

function VersionDialog({ version, current, onClose }) {
  const { data } = useVersion(version);
  const lines = useMemo(() => (data ? diffLines(data.snapshot.system_prompt, current.system_prompt) : []), [data, current.system_prompt]);
  const changedSettings = data
    ? EDITABLE.filter((k) => k !== 'system_prompt' && JSON.stringify(data.snapshot[k]) !== JSON.stringify(current[k]))
    : [];
  return (
    <Dialog open={!!version} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Version {version} compared with the current one (v{current.version})</DialogTitle>
          <DialogDescription><span className="text-destructive">Red</span> lines exist only in v{version}; <span className="text-success">green</span> lines were added since.</DialogDescription>
        </DialogHeader>
        {changedSettings.length > 0 && (
          <div className="rounded-lg border p-3 text-xs">
            <p className="mb-1 font-bold">Other settings that differ</p>
            {changedSettings.map((k) => (
              <p key={k} className="font-mono">{k}: {JSON.stringify(data.snapshot[k])} → {JSON.stringify(current[k])}</p>
            ))}
          </div>
        )}
        <pre className="max-h-[50vh] overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
          {lines.map((l, i) => (
            <div key={i} className={cn('whitespace-pre-wrap', l.type === 'added' && 'bg-success/15 text-success', l.type === 'removed' && 'bg-destructive/10 text-destructive line-through decoration-destructive/40')}>
              {l.type === 'added' ? '+ ' : l.type === 'removed' ? '− ' : '  '}{l.text || ' '}
            </div>
          ))}
        </pre>
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
