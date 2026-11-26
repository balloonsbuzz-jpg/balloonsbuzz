import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PaperPlaneRight, MapPin, ArrowCounterClockwise, Play, CheckCircle, Circle, CaretRight, Warning, Robot, Wrench } from '@phosphor-icons/react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, errorMessage } from '@/lib/api';
import { inr } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useAgentConfig } from './useAgentConfig';

// Venue pins to try distance charges (approximate area centres).
const PINS = [
  ['Kondapur', 17.4615, 78.3647],
  ['Gachibowli', 17.4401, 78.3489],
  ['Kukatpally', 17.4948, 78.3996],
  ['Secunderabad', 17.4399, 78.4983],
  ['Shamshabad (far)', 17.2403, 78.4294],
];

const OUTCOME = {
  replied: ['Replied', 'bg-success/15 text-success'],
  handover: ['Handed over', 'bg-accent text-accent-foreground'],
  blocked: ['Blocked by price guard', 'bg-destructive/10 text-destructive'],
  error: ['Error', 'bg-destructive/10 text-destructive'],
  skipped_human: ['Skipped (team has the chat)', 'bg-muted text-muted-foreground'],
  skipped_disabled: ['Skipped (bot off)', 'bg-muted text-muted-foreground'],
  running: ['Running', 'bg-muted text-muted-foreground'],
};

const FIELDS = [
  ['event_date', 'Date', (l) => (l.event_date ? String(l.event_date).slice(0, 10) + (l.event_time ? ` ${l.event_time.slice(0, 5)}` : '') : null)],
  ['occasion', 'Occasion', (l) => l.occasion_name],
  ['theme', 'Theme / design', (l) => l.theme_name || l.theme_text || l.package_name],
  ['venue', 'Venue', (l) => l.venue_address || (l.venue_lat != null ? `Pin, ${l.distance_km} km` : null)],
  ['budget', 'Budget', (l) => (l.budget_max != null ? `${inr(l.budget_min ?? l.budget_max)}–${inr(l.budget_max)}` : null)],
];

export default function TestChatPage() {
  const qc = useQueryClient();
  const { data: cfg } = useAgentConfig();
  const { data: state } = useQuery({ queryKey: ['sandbox'], queryFn: async () => (await api.get('/agent/sandbox')).data });
  const put = (data) => qc.setQueryData(['sandbox'], data);
  const say = useMutation({
    mutationFn: async (body) => (await api.post('/agent/sandbox/messages', body)).data,
    onSuccess: (data) => {
      put(data);
      if (data.result?.outcome === 'error') toast.error(`The AI could not reply: ${data.result.error}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reset = useMutation({ mutationFn: async () => (await api.post('/agent/sandbox/reset')).data, onSuccess: put });
  const resume = useMutation({ mutationFn: async () => (await api.post('/agent/sandbox/resume')).data, onSuccess: put });

  const mode = state?.conversation?.handling_mode;
  return (
    <>
      <PageHeader
        title="Test chat"
        description="Chat as a customer. This is the real AI with your prompt, prices and photos, but nothing is sent on WhatsApp."
        actions={<Button variant="outline" onClick={() => reset.mutate()} disabled={reset.isPending || say.isPending}><ArrowCounterClockwise size={16} /> New chat</Button>}
      />
      {cfg && !cfg.is_enabled && <Banner>The bot is switched off in <Link to="/ai/agent" className="font-bold underline">AI Agent</Link>, so it won’t answer here or on WhatsApp.</Banner>}
      {cfg && cfg.api_key_source === 'none' && <Banner>No API key for {cfg.provider}: add {cfg.env_key_name} to the server .env or save one in AI Agent → Model & API key.</Banner>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <ChatPane state={state} mode={mode} pending={say.isPending} onSend={(body) => say.mutate(body)} onResume={() => resume.mutate()} />
        <Inspector state={state} />
      </div>
    </>
  );
}

function Banner({ children }) {
  return <p className="mb-4 flex items-start gap-2 rounded-lg bg-accent/60 px-3 py-2 text-sm text-accent-foreground"><Warning size={18} className="mt-px shrink-0" /> <span>{children}</span></p>;
}

function ChatPane({ state, mode, pending, onSend, onResume }) {
  const [text, setText] = useState('');
  const scroller = useRef(null);
  const msgs = state?.messages || [];
  useLayoutEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs.length, pending]);
  const send = () => {
    const t = text.trim();
    if (!t || pending) return;
    onSend({ text: t });
    setText('');
  };
  const sharePin = ([name, lat, lng]) => onSend({ location: { lat, lng, name, address: `${name.replace(/ \(far\)$/, '')}, Hyderabad` } });

  return (
    <div className="flex h-[calc(100dvh-220px)] min-h-[480px] flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <span className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary"><Robot size={20} /></span>
        <div className="min-w-0 flex-1">
          <p className="font-extrabold">BalloonsBuzz</p>
          <p className="text-xs text-muted-foreground">{pending ? 'typing…' : mode === 'bot' ? 'AI assistant' : 'A team member has this chat'}</p>
        </div>
        {mode && mode !== 'bot' && <Button size="sm" variant="secondary" onClick={onResume}><Play size={14} /> Resume bot</Button>}
      </div>

      <div ref={scroller} className="flex-1 space-y-1.5 overflow-y-auto bg-[#efeae2] px-3 py-4 dark:bg-[#0b141a]">
        {!msgs.length && (
          <p className="mx-auto mt-10 max-w-xs rounded-lg bg-card/90 px-3 py-2 text-center text-sm text-muted-foreground shadow-sm">
            Say hi like a customer would, e.g. “Hi, need decoration for my daughter’s 1st birthday, Barbie theme, budget 8k”.
          </p>
        )}
        {msgs.map((m) => <Bubble key={m.id} m={m} />)}
        {pending && <div className="w-16 rounded-lg bg-white px-3 py-2 text-center text-lg leading-none text-muted-foreground shadow-sm dark:bg-[#202c33]">···</div>}
      </div>

      <form className="flex items-end gap-2 border-t bg-card p-2.5" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" size="icon" variant="ghost" aria-label="Share a venue location" disabled={pending} />}>
            <MapPin size={20} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {PINS.map((p) => <DropdownMenuItem key={p[0]} onClick={() => sharePin(p)}>📍 {p[0]}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        <textarea
          aria-label="Message as the customer" rows={1} value={text} maxLength={2000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Message as the customer…"
          className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-3 focus:ring-ring/40"
        />
        <Button type="submit" size="lg" className="h-10" disabled={!text.trim() || pending} aria-label="Send"><PaperPlaneRight size={18} weight="fill" /></Button>
      </form>
    </div>
  );
}

function Bubble({ m }) {
  if (m.is_internal_note) {
    return <p className="mx-auto my-2 max-w-md rounded-lg bg-amber-100 px-3 py-1.5 text-center text-xs font-bold whitespace-pre-line text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">{m.body}</p>;
  }
  const mine = m.direction === 'inbound';   // the tester is the customer
  const time = new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[78%] rounded-lg px-2.5 py-1.5 text-[14px] leading-snug text-[#111b21] shadow-sm dark:text-[#e9edef]',
        mine ? 'bg-[#d9fdd3] dark:bg-[#005c4b]' : 'bg-white dark:bg-[#202c33]')}>
        {m.message_type === 'image' && m.image_url && <img src={m.image_url} alt={m.body || 'Design photo'} className="mb-1 aspect-square w-60 max-w-full rounded-md object-cover" />}
        {m.message_type === 'location' && <p className="font-bold">📍 {m.payload?.name || 'Location'}</p>}
        {m.payload?.send_type === 'location_request' ? (
          <>
            <p className="whitespace-pre-line">{m.body || m.payload?.text}</p>
            <p className="mt-1 border-t pt-1 text-center text-sm font-bold text-[#027eb5]">📍 Send location</p>
          </>
        ) : m.message_type !== 'location' && m.body && <p className="whitespace-pre-line">{m.body}</p>}
        <p className="mt-0.5 text-right text-[10px] text-[#667781] dark:text-[#8696a0]">{m.sender_type === 'system' ? 'auto · ' : ''}{time}</p>
      </div>
    </div>
  );
}

function Inspector({ state }) {
  const lead = state?.lead || {};
  return (
    <Tabs defaultValue="lead" className="min-w-0">
      <TabsList className="w-full">
        <TabsTrigger value="lead">What it knows</TabsTrigger>
        <TabsTrigger value="runs">Behind the scenes</TabsTrigger>
      </TabsList>
      <TabsContent value="lead" className="space-y-3">
        <section className="rounded-xl border bg-card p-4">
          <h3 className="mb-2 font-extrabold">Event details</h3>
          <ul className="space-y-1.5 text-sm">
            {FIELDS.map(([k, label, get]) => {
              const v = state?.lead ? get(lead) : null;
              return (
                <li key={k} className="flex items-center gap-2">
                  {v ? <CheckCircle size={16} weight="fill" className="text-success" /> : <Circle size={16} className="text-muted-foreground" />}
                  <span className="w-20 text-muted-foreground">{label}</span>
                  <span className="min-w-0 flex-1 truncate font-bold">{v || '—'}</span>
                </li>
              );
            })}
          </ul>
          {lead.distance_charge != null && <p className="mt-2 text-xs text-muted-foreground">Travel charge {inr(lead.distance_charge)} ({lead.distance_km} km)</p>}
        </section>
        <section className="rounded-xl border bg-card p-4">
          <h3 className="mb-2 font-extrabold">Quotes</h3>
          {!state?.quotes?.length && <p className="text-sm text-muted-foreground">No price given yet.</p>}
          <ul className="space-y-2 text-sm">
            {state?.quotes?.map((q) => (
              <li key={q.id} className={cn('rounded-lg border px-3 py-2', q.status === 'superseded' && 'opacity-50')}>
                <p className="font-bold">{q.package}{q.photo ? ` · ${q.photo}` : ''}</p>
                <p className="text-muted-foreground">
                  Now <b className="text-foreground">{inr(q.final_price)}</b> · lowest {inr(q.floor_price)} · {q.status}{q.rounds_used ? ` · ${q.rounds_used} discount round${q.rounds_used > 1 ? 's' : ''}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </TabsContent>
      <TabsContent value="runs">
        <ul className="space-y-2">
          {!state?.runs?.length && <li className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">Each AI reply shows up here with the tools it used.</li>}
          {state?.runs?.map((r) => <RunCard key={r.id} r={r} />)}
        </ul>
      </TabsContent>
    </Tabs>
  );
}

function RunCard({ r }) {
  const [label, tone] = OUTCOME[r.outcome] || [r.outcome, 'bg-muted'];
  return (
    <li className="rounded-xl border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', tone)}>{label}</span>
        <span className="text-xs text-muted-foreground">
          {new Date(r.started_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })} · {r.model} · {((r.latency_ms || 0) / 1000).toFixed(1)} s · {r.input_tokens + r.output_tokens} tokens · ₹{Number(r.cost_inr).toFixed(2)}
        </span>
      </div>
      {r.blocked_reason && <p className="mt-1 text-xs text-destructive">Blocked: {r.blocked_reason.replace('unknown_price:', 'mentioned a price no tool gave: ₹')}</p>}
      {r.error_message && <p className="mt-1 text-xs text-destructive">{r.error_message}</p>}
      <ul className="mt-2 space-y-1">
        {r.tool_calls.map((t, i) => <ToolCall key={i} t={t} />)}
      </ul>
    </li>
  );
}

function ToolCall({ t }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg bg-muted/60">
      <button type="button" className="flex w-full items-center gap-2 px-2 py-1.5 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <CaretRight size={12} className={cn('transition-transform', open && 'rotate-90')} />
        <Wrench size={13} />
        <span className="font-mono text-xs font-bold">{t.tool}</span>
        {!t.success && <span className="text-[11px] font-bold text-destructive">failed</span>}
        <span className="ml-auto text-[11px] text-muted-foreground">{t.ms ?? 0} ms</span>
      </button>
      {open && (
        <div className="space-y-1 px-2 pb-2">
          <pre className="max-h-40 overflow-auto rounded bg-background p-2 text-[11px] leading-4">{JSON.stringify(t.arguments, null, 2)}</pre>
          <pre className="max-h-60 overflow-auto rounded bg-background p-2 text-[11px] leading-4">{t.error || JSON.stringify(t.result, null, 2)}</pre>
        </div>
      )}
    </li>
  );
}

