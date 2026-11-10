import { useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { DownloadSimple, Table as TableIcon, ChartBar } from '@phosphor-icons/react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Stat, DailyColumns, Bars, Card, duration, rupees, percent, count } from './charts';

const TRIGGER = {
  customer_request: 'Customer asked for a person', keyword: 'Handover keyword', discount_limit: 'Discount beyond the limit',
  bot_stuck: 'Bot got stuck', out_of_area: 'Outside service area', date_unavailable: 'Date not available', system: 'System (e.g. price guard)',
  agent_takeover: 'Team took over', agent_pause: 'Team paused the bot', agent_reply: 'Team replied in chat',
};

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function preset(key) {
  const now = new Date(); const today = iso(now);
  const back = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return iso(d); };
  switch (key) {
    case '7d': return { from: back(6), to: today };
    case '90d': return { from: back(89), to: today };
    case 'month': return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    case 'last_month': return { from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: iso(new Date(now.getFullYear(), now.getMonth(), 0)) };
    default: return { from: back(29), to: today };
  }
}
const PRESETS = [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['last_month', 'Last month'], ['90d', 'Last 90 days']];

const METRICS = [
  { key: 'leads', label: 'Enquiries', format: count },
  { key: 'bookings', label: 'Bookings', format: count },
  { key: 'booked_value', label: 'Booked value', format: rupees, money: true },
  { key: 'collected', label: 'Collected', format: rupees, money: true },
  { key: 'ai_cost', label: 'AI cost', format: (v) => rupees(v, true), money: true },
];

export default function AnalyticsPage() {
  const [presetKey, setPresetKey] = useState('30d');
  const [range, setRange] = useState(() => preset('30d'));
  const [metric, setMetric] = useState('leads');
  const [asTable, setAsTable] = useState(false);
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['analytics', range.from, range.to],
    queryFn: async () => (await api.get('/analytics', { params: range })).data,
    placeholderData: keepPreviousData,
    enabled: !!range.from && !!range.to && range.from <= range.to,
  });
  const choose = (k) => { setPresetKey(k); setRange(preset(k)); };
  const setDay = (k, v) => { setPresetKey('custom'); setRange((r) => ({ ...r, [k]: v })); };
  const m = METRICS.find((x) => x.key === metric);
  const series = useMemo(() => (data?.daily || []).map((d) => ({ day: d.day, value: d[metric] })), [data, metric]);
  const exportHref = (kind) => `/api/analytics/export?${new URLSearchParams({ kind, ...range })}`;

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Enquiries, bookings, money and how the bot is doing. Days follow India time; test-chat conversations are never counted."
        actions={(
          <>
            <a href={exportHref('daily')} download className={buttonVariants({ variant: 'outline', size: 'sm' })}><DownloadSimple size={15} /> Daily CSV</a>
            <a href={exportHref('bookings')} download className={buttonVariants({ variant: 'outline', size: 'sm' })}><DownloadSimple size={15} /> Bookings CSV</a>
          </>
        )}
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {PRESETS.map(([k, l]) => (
          <button key={k} type="button" onClick={() => choose(k)} aria-pressed={presetKey === k}
            className={cn('rounded-full px-3 py-1 text-xs font-bold', presetKey === k ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/70')}>{l}</button>
        ))}
        <span className="flex items-center gap-1.5 text-sm">
          <Input type="date" value={range.from} max={range.to} onChange={(e) => setDay('from', e.target.value)} className="h-8 w-[9.5rem]" aria-label="From date" />
          <span className="text-muted-foreground">to</span>
          <Input type="date" value={range.to} min={range.from} onChange={(e) => setDay('to', e.target.value)} className="h-8 w-[9.5rem]" aria-label="To date" />
        </span>
        {isFetching && <span className="text-xs text-muted-foreground">Updating…</span>}
      </div>

      {error && <p className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{errorMessage(error)}</p>}
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && <Report data={data} m={m} metric={metric} setMetric={setMetric} series={series} asTable={asTable} setAsTable={setAsTable} />}
    </>
  );
}

function Report({ data, m, metric, setMetric, series, asTable, setAsTable }) {
  const { funnel: f, bookings: b, events: e, response: r, handover: h, ai, previous: p } = data;
  const prevLabel = `${new Date(`${data.previous_range.from}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${new Date(`${data.previous_range.to}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
  return (
    <>
      <p className="mb-2 text-xs text-muted-foreground">Arrows compare with the {data.range.days} days before ({prevLabel}).</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Enquiries" value={count(f.leads)} now={f.leads} before={p.funnel.leads} />
        <Stat label="Bookings" value={count(b.count)} now={b.count} before={p.bookings.count} sub={b.cancelled ? `${b.cancelled} cancelled` : null} />
        <Stat label="Enquiry → booking" value={percent(f.conversion_pct)} now={f.conversion_pct} before={p.funnel.conversion_pct} />
        <Stat label="Booked value" value={rupees(b.booked_value)} now={b.booked_value} before={p.bookings.booked_value} sub={b.avg_value ? `avg ${rupees(b.avg_value)}` : null} />
        <Stat label="Money collected" value={rupees(b.collected)} now={b.collected} before={p.bookings.collected} sub="advances and payments, less refunds" />
        <Stat label="Typical reply time" value={duration(r.median_secs)} now={r.median_secs} before={p.response.median_secs} better="down" sub="median" />
        <Stat label="Chats handed to the team" value={percent(h.rate_pct)} now={h.rate_pct} before={p.handover.rate_pct} better="down" sub={`${h.handed_chats} of ${h.active_chats} chats`} />
        <Stat label="AI cost" value={rupees(ai.cost, true)} now={ai.cost} before={p.ai.cost} better="down" sub={ai.cost_per_booking != null ? `${rupees(ai.cost_per_booking, true)} per booking` : null} />
      </div>

      <Card className="mt-4" title="Day by day"
        action={(
          <Button size="sm" variant="ghost" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
            {asTable ? <><ChartBar size={15} /> Chart</> : <><TableIcon size={15} /> Table</>}
          </Button>
        )}>
        <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Metric">
          {METRICS.map((x) => (
            <button key={x.key} type="button" role="tab" aria-selected={metric === x.key} onClick={() => setMetric(x.key)}
              className={cn('rounded-full px-2.5 py-0.5 text-xs font-bold', metric === x.key ? 'bg-foreground text-background' : 'bg-muted hover:bg-muted/70')}>{x.label}</button>
          ))}
        </div>
        {asTable ? <DailyTable rows={data.daily} /> : <DailyColumns data={series} format={m.format} money={m.money} label={m.label} />}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Enquiry funnel">
          <Bars max={f.leads || 1} rows={[
            { label: 'Enquiries', value: f.leads },
            { label: 'Details collected', value: f.qualified, note: share(f.qualified, f.leads) },
            { label: 'Got a price', value: f.quoted, note: share(f.quoted, f.leads) },
            { label: 'Booked', value: f.booked, note: share(f.booked, f.leads) },
          ]} />
          <p className="mt-3 text-xs text-muted-foreground">Enquiries started in this period, followed to where they got. {f.lost ? `${f.lost} marked lost.` : ''}</p>
        </Card>

        <Card title="Reply times">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Fact k="Bot (median)" v={duration(r.bot_median_secs)} sub={`${r.by_bot} replies`} />
            <Fact k="Team (median)" v={duration(r.team_median_secs)} sub={`${r.by_team} replies`} />
            <Fact k="Slowest 10% wait over" v={duration(r.p90_secs)} />
            <Fact k="No reply went out" v={count(r.unanswered)} sub={`of ${r.turns} customer messages`} />
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">Time from a customer’s message to the first reply that was actually sent. The bot waits a few seconds on purpose so it feels human.</p>
        </Card>

        <Card title="Handed to the team">
          <dl className="mb-4 grid grid-cols-2 gap-3 text-sm">
            <Fact k="Bot asked for help" v={count(h.escalated_chats)} sub="chats" />
            <Fact k="Team stepped in" v={count(h.team_stepped_in_chats)} sub="chats" />
          </dl>
          <Bars rows={data.breakdowns.handover_triggers.map((t) => ({ label: TRIGGER[t.trigger] || t.trigger, value: t.n }))} empty="No handovers in this period." />
        </Card>

        <Card title="AI agent">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Fact k="Replies worked on" v={count(ai.runs)} sub={`${count(ai.tokens)} tokens`} />
            <Fact k="Cost" v={rupees(ai.cost, true)} sub={ai.cost_per_booking != null ? `${rupees(ai.cost_per_booking, true)} per booking` : 'no bookings yet'} />
            <Fact k="Price guard stopped a reply" v={count(ai.blocked)} sub="sent to the team instead" />
            <Fact k="Average thinking time" v={ai.avg_latency_ms != null ? `${(ai.avg_latency_ms / 1000).toFixed(1)}s` : '—'} />
          </dl>
          {(ai.sandbox_runs > 0 || ai.errors > 0) && (
            <p className="mt-3 text-xs text-muted-foreground">
              {ai.sandbox_runs > 0 && `Test chat used ${rupees(ai.sandbox_cost, true)} over ${ai.sandbox_runs} replies (not included above). `}
              {ai.errors > 0 && `${ai.errors} replies failed with a provider error.`}
            </p>
          )}
        </Card>

        <Card title="Events in this period">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Fact k="Events" v={count(e.count)} sub={`${e.completed} completed`} />
            <Fact k="Value" v={rupees(e.value)} />
            <Fact k="Balance still to collect" v={rupees(e.balance_due)} />
            <Fact k="Discount given" v={rupees(b.discount_given)} sub="on bookings made" />
          </dl>
        </Card>

        <Card title="What gets booked">
          <Breakdown data={data.breakdowns} />
        </Card>
      </div>
    </>
  );
}

const share = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '');

function Fact({ k, v, sub }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className="text-lg font-extrabold tabular-nums">{v}{sub && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{sub}</span>}</dd>
    </div>
  );
}

function Breakdown({ data }) {
  const [tab, setTab] = useState('occasions');
  const tabs = [['occasions', 'Occasion'], ['packages', 'Package'], ['themes', 'Theme'], ['lost', 'Lost reasons']];
  const rows = tab === 'lost'
    ? data.lost_reasons.map((x) => ({ label: x.reason, value: x.n }))
    : data[tab].map((x) => ({ label: x.name, value: x.bookings, note: rupees(x.value) }));
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {tabs.map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)} aria-pressed={tab === k}
            className={cn('rounded-full px-2.5 py-0.5 text-xs font-bold', tab === k ? 'bg-foreground text-background' : 'bg-muted hover:bg-muted/70')}>{l}</button>
        ))}
      </div>
      <Bars rows={rows} empty={tab === 'lost' ? 'No lost enquiries in this period.' : 'No bookings in this period.'} />
    </>
  );
}

function DailyTable({ rows }) {
  return (
    <div className="max-h-80 overflow-auto rounded-lg border">
      <table className="w-full text-sm tabular-nums">
        <thead className="sticky top-0 bg-muted text-xs">
          <tr>{['Day', 'Enquiries', 'Bookings', 'Booked value', 'Collected', 'AI cost'].map((h, i) => <th key={h} className={cn('px-3 py-2 font-bold', i ? 'text-right' : 'text-left')}>{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((d) => (
            <tr key={d.day}>
              <td className="px-3 py-1.5">{new Date(`${d.day}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</td>
              <td className="px-3 py-1.5 text-right">{d.leads}</td>
              <td className="px-3 py-1.5 text-right">{d.bookings}</td>
              <td className="px-3 py-1.5 text-right">{rupees(d.booked_value)}</td>
              <td className="px-3 py-1.5 text-right">{rupees(d.collected)}</td>
              <td className="px-3 py-1.5 text-right">{rupees(d.ai_cost, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
