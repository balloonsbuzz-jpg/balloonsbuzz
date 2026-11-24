import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { CheckCircle, WarningCircle, Copy, PaperPlaneTilt, ArrowsClockwise, Plugs, Broadcast } from '@phosphor-icons/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { Field } from '@/pages/ai/fields';

const STATUS_STYLE = {
  connected: 'bg-success/15 text-success',
  pending: 'bg-accent text-accent-foreground',
  error: 'bg-destructive/10 text-destructive',
  disconnected: 'bg-muted text-muted-foreground',
};

function useWhatsApp() {
  return useQuery({ queryKey: ['wa-settings'], queryFn: async () => (await api.get('/settings/whatsapp')).data });
}

export default function WhatsAppSettings() {
  const { can } = useAuth();
  const canWrite = can('settings:write');
  const { data, isLoading } = useWhatsApp();
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const { account, webhook } = data;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ConnectionCard account={account} canWrite={canWrite} envToken={webhook.env_token_configured} />
      <div className="space-y-4">
        <StatusCard account={account} canWrite={canWrite} />
        <WebhookCard webhook={webhook} />
      </div>
      {account && canWrite && <TestMessageCard />}
      <EventsCard />
    </div>
  );
}

function ConnectionCard({ account, canWrite, envToken }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ display_phone: '', display_name: '', phone_number_id: '', waba_id: '', access_token: '', read_receipts_enabled: true });
  useEffect(() => {
    if (account) {
      setForm((f) => ({ ...f, display_phone: `+${account.display_phone}`, display_name: account.display_name || '',
        phone_number_id: account.phone_number_id, waba_id: account.waba_id, read_receipts_enabled: account.read_receipts_enabled, access_token: '' }));
    }
  }, [account]);
  const save = useMutation({
    mutationFn: async () => {
      const body = { ...form };
      if (!body.access_token) delete body.access_token;
      return (await api.put('/settings/whatsapp', body)).data.account;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['wa-settings'] }); toast.success('WhatsApp number saved. Run “Check connection” next.'); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Plugs size={18} /> WhatsApp number</CardTitle>
        <CardDescription><Link to="/connect" className={buttonVariants({ size: 'sm', className: 'mb-2 w-fit' })}>Connect with Facebook (recommended)</Link><br />Or enter the details by hand, from Meta Business Manager → WhatsApp Manager → Phone numbers (or the app’s WhatsApp → API Setup page).</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <fieldset disabled={!canWrite} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="display_phone" label="WhatsApp number" hint="With country code">
                <Input id="display_phone" placeholder="+91 93925 34625" value={form.display_phone} onChange={set('display_phone')} required />
              </Field>
              <Field id="display_name" label="Display name">
                <Input id="display_name" placeholder="BalloonsBuzz" value={form.display_name} onChange={set('display_name')} />
              </Field>
            </div>
            <Field id="phone_number_id" label="Phone number ID" hint="A long numeric ID from Meta, not the phone number itself.">
              <Input id="phone_number_id" inputMode="numeric" placeholder="e.g. 109876543210987" value={form.phone_number_id} onChange={set('phone_number_id')} required />
            </Field>
            <Field id="waba_id" label="WhatsApp Business Account ID">
              <Input id="waba_id" inputMode="numeric" placeholder="e.g. 223344556677889" value={form.waba_id} onChange={set('waba_id')} required />
            </Field>
            <Field id="access_token" label="Access token"
              hint={account?.token_source === 'ui' ? 'A token is saved (encrypted). Paste a new one only to replace it.'
                : (account?.token_source === 'env' || (!account && envToken)) ? 'Using WHATSAPP_ACCESS_TOKEN from the server .env. Paste one here to override.'
                  : 'Use a permanent System User token with whatsapp_business_messaging permission.'}>
              <Input id="access_token" type="password" autoComplete="off" placeholder={account?.token_source === 'ui' ? '•••••••• (saved)' : 'EAA…'} value={form.access_token} onChange={set('access_token')} />
            </Field>
            <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <span><span className="block text-sm font-bold">Blue ticks (read receipts)</span><span className="text-xs text-muted-foreground">Mark customer messages as read when the bot or team replies</span></span>
              <Switch checked={form.read_receipts_enabled} onCheckedChange={set('read_receipts_enabled')} aria-label="Read receipts" />
            </label>
          </fieldset>
          {canWrite && <Button type="submit" size="lg" disabled={save.isPending}>{save.isPending ? 'Saving…' : account ? 'Save changes' : 'Connect number'}</Button>}
        </form>
      </CardContent>
    </Card>
  );
}

function StatusCard({ account, canWrite }) {
  const qc = useQueryClient();
  const check = useMutation({
    mutationFn: async () => (await api.post('/settings/whatsapp/health')).data,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['wa-settings'] });
      r.result.ok ? toast.success(`Connected: ${r.result.verified_name}`) : toast.error(r.result.error);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const h = account?.last_health_status || {};
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connection status</CardTitle>
        <CardDescription>Asks Meta whether this number and token work.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!account ? <p className="text-sm text-muted-foreground">No number connected yet.</p> : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-extrabold capitalize', STATUS_STYLE[account.status])}>{account.status}</span>
              {account.last_health_check_at && <span className="text-xs text-muted-foreground">checked {formatDistanceToNow(new Date(account.last_health_check_at), { addSuffix: true })}</span>}
            </div>
            {h.ok && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Verified name</dt><dd className="font-bold">{h.verified_name}</dd>
                <dt className="text-muted-foreground">Number</dt><dd>{h.display_phone_number}</dd>
                <dt className="text-muted-foreground">Quality</dt><dd>{h.quality_rating || '—'}</dd>
                {h.messaging_limit_tier && <><dt className="text-muted-foreground">Messaging limit</dt><dd>{h.messaging_limit_tier}</dd></>}
              </dl>
            )}
            {h.ok === false && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{h.error}</p>}
            {canWrite && (
              <Button variant="outline" onClick={() => check.mutate()} disabled={check.isPending}>
                <ArrowsClockwise size={16} className={cn(check.isPending && 'animate-spin')} /> Check connection
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Copyable({ value }) {
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs">{value}</code>
      <Button variant="outline" size="icon-sm" aria-label="Copy" onClick={() => navigator.clipboard?.writeText(value).then(() => toast.success('Copied'))}>
        <Copy size={14} />
      </Button>
    </div>
  );
}

function Check({ ok, children }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok ? <CheckCircle size={18} weight="fill" className="mt-px shrink-0 text-success" /> : <WarningCircle size={18} weight="fill" className="mt-px shrink-0 text-warning" />}
      <span>{children}</span>
    </li>
  );
}

function WebhookCard({ webhook }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Broadcast size={18} /> Webhook (incoming messages)</CardTitle>
        <CardDescription>Set automatically for a number connected with Facebook. By hand: Meta app → WhatsApp → Configuration → Webhook, field “messages”.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <p className="text-xs font-bold text-muted-foreground">Callback URL</p>
          {webhook.callback_url ? <Copyable value={webhook.callback_url} />
            : <p className="text-sm text-warning">Set PUBLIC_BASE_URL in the server .env to the public https address of this app.</p>}
        </div>
        <ul className="space-y-1.5">
          <Check ok={webhook.verify_token_configured}>Verify token {webhook.verify_token_configured ? 'is set (WHATSAPP_WEBHOOK_VERIFY_TOKEN, paste the same value in Meta)' : 'missing: set WHATSAPP_WEBHOOK_VERIFY_TOKEN'}</Check>
          <Check ok={webhook.app_secret_configured}>App secret {webhook.app_secret_configured ? 'is set (signatures are verified)' : 'missing: set META_APP_SECRET. Incoming messages are refused until it is set.'}</Check>
          <Check ok={!!webhook.callback_url}>Meta requires HTTPS for the callback URL</Check>
        </ul>
        <p className="text-xs text-muted-foreground">Graph API {webhook.api_version}</p>
      </CardContent>
    </Card>
  );
}

function TestMessageCard() {
  const [phone, setPhone] = useState('');
  const [type, setType] = useState('template');
  const [text, setText] = useState('Hello from BalloonsBuzz 🎈');
  const [sentId, setSentId] = useState(null);
  const send = useMutation({
    mutationFn: async () => (await api.post('/settings/whatsapp/test-message', { phone, type, ...(type === 'text' ? { text } : {}) })).data.message,
    onSuccess: (m) => setSentId(m.id),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const status = useQuery({
    queryKey: ['wa-test', sentId], enabled: !!sentId,
    queryFn: async () => (await api.get(`/settings/whatsapp/test-message/${sentId}`)).data.message,
    refetchInterval: (q) => (['read', 'failed'].includes(q.state.data?.status) ? false : 2000),
  });
  const m = status.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><PaperPlaneTilt size={18} /> Send a test message</CardTitle>
        <CardDescription>Plain text only works if that number messaged this WhatsApp number in the last 24 hours. Otherwise use the <code>hello_world</code> template.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setSentId(null); send.mutate(); }}>
          <Field id="test_phone" label="To (your own WhatsApp number)">
            <Input id="test_phone" placeholder="+91 98xxx xxxxx" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          </Field>
          <div className="flex gap-2" role="radiogroup" aria-label="Message type">
            {[['template', 'Template (hello_world)'], ['text', 'Text']].map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={type === v} onClick={() => setType(v)}
                className={cn('rounded-lg border px-3 py-1.5 text-sm font-bold', type === v ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground')}>{l}</button>
            ))}
          </div>
          {type === 'text' && <Input aria-label="Text" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />}
          <Button type="submit" disabled={!phone || send.isPending}>{send.isPending ? 'Queuing…' : 'Send test'}</Button>
        </form>
        {m && (
          <div className="mt-4 rounded-lg border p-3 text-sm">
            <p>Status: <b className="capitalize">{m.status}</b>{m.status === 'read' ? ' ✓✓' : ''}</p>
            {m.error_message && <p className="mt-1 text-destructive">{m.error_message}</p>}
            {m.status === 'sent' && <p className="mt-1 text-xs text-muted-foreground">“Delivered/Read” appear once Meta’s webhook can reach this server.</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EventsCard() {
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['wa-events'], queryFn: async () => (await api.get('/settings/whatsapp/events')).data.events, refetchInterval: 10_000,
  });
  return (
    <Card className={cn(!data?.length && 'lg:col-span-1')}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">Recent webhook events
          <Button variant="ghost" size="icon-sm" aria-label="Refresh" onClick={() => refetch()}><ArrowsClockwise size={15} className={cn(isFetching && 'animate-spin')} /></Button>
        </CardTitle>
        <CardDescription>What Meta sent us, newest first. Useful when setting up the webhook.</CardDescription>
      </CardHeader>
      <CardContent>
        {!data?.length ? <p className="text-sm text-muted-foreground">Nothing received yet.</p> : (
          <ul className="divide-y text-sm">
            {data.map((e) => (
              <li key={e.id} className="flex items-center gap-3 py-2">
                <span className="w-16 shrink-0 text-xs font-bold capitalize">{e.event_type.replace('_', ' ')}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{e.event_key}</span>
                <span className={cn('rounded-full px-2 py-px text-[11px] font-bold',
                  e.status === 'processed' ? 'bg-success/15 text-success' : e.status === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-muted')}>{e.status}</span>
                <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{formatDistanceToNow(new Date(e.received_at))}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
