import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle, CircleNotch, DeviceMobile, FacebookLogo, Phone, Plugs, SimCard, WarningCircle } from '@phosphor-icons/react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { loadFacebookSdk, openSignup } from '@/lib/facebook';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { Field } from '@/pages/ai/fields';

const METHODS = [
  {
    key: 'coexistence', icon: DeviceMobile, title: 'Keep using the WhatsApp Business app',
    text: 'For a number already in the WhatsApp Business app. The phone keeps working, and the same chats appear here. Called “coexistence” by Meta.',
    before: ['The WhatsApp Business app (not the personal one), updated to version 2.24.17 or newer', 'The phone with you, to scan a QR code during setup', 'A Facebook login that manages the business'],
  },
  {
    key: 'new', icon: SimCard, title: 'Use a new number',
    text: 'For a number that is not on WhatsApp at all. It will work only here, not in the app on a phone.',
    before: ['A mobile or landline number that can receive an SMS or call', 'If it was on WhatsApp before: delete that account first (Settings → Account → Delete account)', 'A Facebook login that manages the business'],
  },
];

const STEP_LABEL = {
  subscribe: 'WhatsApp account linked to the app', webhook: 'Messages delivered to this dashboard', register: 'Number registered with Meta',
  sync_contacts: 'Phone contacts requested', sync_history: 'Chat history requested', check: 'Connection checked',
};
const SYNC_LABEL = { requested: 'Waiting for the phone', syncing: 'Importing', completed: 'Imported', failed: 'Failed', declined: 'Not shared from the phone' };

export default function ConnectNumberPage() {
  const { can } = useAuth();
  const canWrite = can('settings:write');
  const wa = useQuery({
    queryKey: ['wa-settings'], queryFn: async () => (await api.get('/settings/whatsapp')).data,
    refetchInterval: (q) => (['requested', 'syncing'].includes(q.state.data?.account?.history_sync_status) ? 10_000 : false),
  });
  const config = useQuery({ queryKey: ['wa-signup-config'], queryFn: async () => (await api.get('/settings/whatsapp/signup-config')).data, staleTime: Infinity });
  const account = wa.data?.account;
  const connected = account && account.status !== 'disconnected';
  const [another, setAnother] = useState(false);

  return (
    <>
      <PageHeader title="Connect WhatsApp number" description="Link the BalloonsBuzz number through Facebook. It takes about five minutes." />
      {wa.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p>
        : wa.error ? <p className="text-sm text-destructive">{errorMessage(wa.error)}</p> : (
          <div className="space-y-4">
            {connected && <ConnectedCard account={account} canWrite={canWrite} onReplace={() => setAnother(true)} />}
            {(!connected || another) && (canWrite
              ? <ConnectCard config={config.data} error={config.error} replacing={connected ? account : null} onDone={() => setAnother(false)} />
              : <p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">No number is connected. Ask the owner to connect one.</p>)}
          </div>
        )}
    </>
  );
}

function ConnectCard({ config, error, replacing, onDone }) {
  const qc = useQueryClient();
  const [method, setMethod] = useState('coexistence');
  const [FB, setFB] = useState(null);
  const [sdkError, setSdkError] = useState(null);
  const [pin, setPin] = useState('');
  const chosen = METHODS.find((m) => m.key === method);

  // Loaded ahead of the click: a popup opened after a network wait gets blocked.
  useEffect(() => {
    if (!config?.enabled) return;
    loadFacebookSdk(config).then((fb) => setFB(() => fb), (e) => setSdkError(e.message));
  }, [config]);

  const connect = useMutation({
    mutationFn: async (popup) => {
      const result = await popup;
      const body = { ...result, mode: method, ...(method === 'new' && pin ? { pin } : {}) };
      return (await api.post('/settings/whatsapp/embedded-signup', body, { timeout: 90_000 })).data.account;
    },
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ['wa-settings'] });
      if (a.status === 'connected') toast.success(`+${a.display_phone} is connected`);
      else toast.warning('The number is linked, but one step still needs attention.');
      onDone();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const badPin = pin !== '' && !/^\d{6}$/.test(pin);
  const start = () => connect.mutate(openSignup(FB, config.config_id, method === 'coexistence'));

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card>
        <CardHeader>
          <CardTitle>{replacing ? 'Connect again or use a different number' : 'How will you use this number?'}</CardTitle>
          <CardDescription>{replacing ? `This replaces +${replacing.display_phone}. Existing chats stay in the inbox.` : 'Both options work with the inbox, the AI agent, templates and broadcasts.'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Connection method">
            {METHODS.map((m) => (
              <button key={m.key} type="button" role="radio" aria-checked={method === m.key} disabled={connect.isPending} onClick={() => setMethod(m.key)}
                className={cn('flex flex-col items-start rounded-xl border p-4 text-left transition-colors', method === m.key ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/50')}>
                <m.icon size={24} className={method === m.key ? 'text-primary' : 'text-muted-foreground'} />
                <span className="mt-2 block font-bold">{m.title}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{m.text}</span>
              </button>
            ))}
          </div>

          <div className="rounded-lg bg-muted/60 p-3">
            <p className="mb-1.5 text-sm font-bold">Before you start</p>
            <ul className="space-y-1">
              {chosen.before.map((t) => <li key={t} className="flex gap-2 text-sm"><CheckCircle size={17} className="mt-0.5 shrink-0 text-success" />{t}</li>)}
            </ul>
          </div>

          {method === 'new' && (
            <Field id="signup_pin" label="Two-step PIN (optional)" error={badPin ? 'The PIN is 6 digits' : undefined}
              hint="Only if the number already has a WhatsApp two-step verification PIN. Otherwise one is created and kept safely.">
              <Input id="signup_pin" inputMode="numeric" maxLength={6} autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} className="max-w-40" />
            </Field>
          )}

          {(error || sdkError) && <Notice>{sdkError || errorMessage(error)}</Notice>}
          {config && !config.enabled && <Notice>Connecting is not set up on the server yet. Missing settings: <b>{config.missing.join(', ')}</b></Notice>}
          {config?.enabled && window.location.origin !== config.dashboard_origin && (
            <Notice>Facebook only allows connecting from <b>{config.dashboard_origin}</b>. Open the dashboard there.</Notice>
          )}

          <Button size="lg" disabled={!FB || badPin || connect.isPending} onClick={start} className="bg-[#1877F2] text-white hover:bg-[#1567d3]">
            {connect.isPending ? <CircleNotch size={18} className="animate-spin" /> : <FacebookLogo size={18} weight="fill" />}
            {connect.isPending ? 'Connecting…' : 'Continue with Facebook'}
          </Button>
          <p className="text-xs text-muted-foreground">
            Already have an access token? <Link to="/settings" className="font-bold text-primary underline-offset-2 hover:underline">Enter the details by hand</Link>
          </p>
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader><CardTitle>What happens next</CardTitle></CardHeader>
        <CardContent>
          <ol className="space-y-3 text-sm">
            {['Sign in to Facebook and choose the business', 'Choose or create the WhatsApp Business account',
              method === 'coexistence' ? 'Enter the number and scan the QR code with the WhatsApp Business app' : 'Enter the number and confirm it by SMS or call',
              method === 'coexistence' ? 'Choose “share chat history” to see past chats here' : 'Press Finish: the number is registered automatically'].map((t, i) => (
                <li key={t} className="flex gap-2.5"><span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-extrabold text-primary">{i + 1}</span>{t}</li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

function ConnectedCard({ account, canWrite, onReplace }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [pin, setPin] = useState('');
  const steps = account.setup_steps || [];
  const failed = steps.filter((s) => !s.ok);
  const refresh = () => qc.invalidateQueries({ queryKey: ['wa-settings'] });

  const finish = useMutation({
    mutationFn: async () => (await api.post('/settings/whatsapp/finish-setup', pin ? { pin } : {}, { timeout: 90_000 })).data.account,
    onSuccess: (a) => { refresh(); setPin(''); a.setup_steps.every((s) => s.ok) ? toast.success('Setup finished') : toast.warning('One step still needs attention'); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const disconnect = useMutation({
    mutationFn: async () => (await api.delete('/settings/whatsapp/connection')).data,
    onSuccess: () => { refresh(); setConfirm(false); toast.success('Number disconnected'); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-success/15 text-success"><Phone size={22} weight="fill" /></span>
          <div className="min-w-0 flex-1">
            <p className="font-bold">+{account.display_phone} {account.display_name && <span className="font-normal text-muted-foreground">· {account.display_name}</span>}</p>
            <p className="text-xs text-muted-foreground">Phone ID {account.phone_number_id} · WhatsApp account {account.waba_id}</p>
          </div>
          <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-extrabold capitalize', account.status === 'connected' ? 'bg-success/15 text-success' : account.status === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-accent text-accent-foreground')}>
            {account.status === 'error' ? 'Needs attention' : account.status}
          </span>
          {account.is_coexistence && <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-extrabold text-primary">Also on phone app</span>}
        </div>

        {steps.length > 0 && (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {steps.map((s) => (
              <li key={s.key} className="flex items-start gap-2 text-sm">
                {s.ok ? <CheckCircle size={18} weight="fill" className="mt-px shrink-0 text-success" /> : <WarningCircle size={18} weight="fill" className="mt-px shrink-0 text-destructive" />}
                <span>{STEP_LABEL[s.key] || s.key}{s.error && <span className="block text-xs text-destructive">{s.error}</span>}</span>
              </li>
            ))}
          </ul>
        )}

        {account.is_coexistence && (account.contacts_sync_status || account.history_sync_status) && (
          <dl className="grid gap-x-6 gap-y-1 rounded-lg bg-muted/60 p-3 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Phone contacts</dt><dd className="font-bold">{SYNC_LABEL[account.contacts_sync_status] || '—'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Chat history</dt>
              <dd className="font-bold">{SYNC_LABEL[account.history_sync_status] || '—'}{account.history_sync_status === 'syncing' && account.history_sync_progress != null && ` ${account.history_sync_progress}%`}</dd></div>
          </dl>
        )}

        {canWrite && (
          <div className="flex flex-wrap items-end gap-2">
            {account.connection_type === 'embedded' && failed.length > 0 && (
              <>
                {failed.some((s) => s.key === 'register') && (
                  <Field id="finish_pin" label="Two-step PIN">
                    <Input id="finish_pin" inputMode="numeric" maxLength={6} autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} className="w-32" />
                  </Field>
                )}
                <Button disabled={finish.isPending || (pin !== '' && !/^\d{6}$/.test(pin))} onClick={() => finish.mutate()}>{finish.isPending ? 'Working…' : 'Finish setup'}</Button>
              </>
            )}
            <Button variant="outline" onClick={onReplace}>Connect again / change number</Button>
            <Button variant="outline" className="text-destructive" onClick={() => setConfirm(true)}><Plugs size={16} /> Disconnect</Button>
          </div>
        )}
      </CardContent>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect +{account.display_phone}?</DialogTitle>
            <DialogDescription>The bot and the team stop sending and receiving on this number here. Chats, contacts and bookings are kept, and you can connect again any time.
              {account.is_coexistence && ' The WhatsApp Business app on the phone keeps working.'}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="destructive" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>{disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Notice({ children }) {
  return <p className="flex gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><WarningCircle size={18} className="mt-px shrink-0" /><span>{children}</span></p>;
}
