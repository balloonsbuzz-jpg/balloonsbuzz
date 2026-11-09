import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow, format } from 'date-fns';
import { GoogleDriveLogo, FileZip, Copy, CaretRight } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const STATUS = {
  running: 'bg-accent text-accent-foreground',
  succeeded: 'bg-success/15 text-success',
  partial: 'bg-accent text-accent-foreground',
  failed: 'bg-destructive/10 text-destructive',
};

export default function ImportsPanel({ config }) {
  const { data } = useQuery({
    queryKey: ['gallery', 'runs'],
    queryFn: async () => (await api.get('/gallery/runs')).data.runs,
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 3000 : false),
  });
  const runs = data || [];
  const [openId, setOpenId] = useState(null);
  const latest = runs.find((r) => r.status !== 'running' && r.status !== 'failed');
  const reportId = openId || latest?.id;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><GoogleDriveLogo size={18} /> Google Drive</CardTitle>
            <CardDescription>
              {config?.drive_connected
                ? `Synced automatically every ${config.sync_interval_min} minutes. Rename a file in Drive and the new name and price arrive on the next sync.`
                : 'Not connected yet. Share the folder as “Anyone with the link” and add the Google API key (GDRIVE_API_KEY) on the server. Until then, photos come from the zip import.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {config && <a href={config.drive_folder_url} target="_blank" rel="noreferrer" className="text-sm font-bold text-primary hover:underline">Open the Drive folder</a>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>History</CardTitle></CardHeader>
          <CardContent className="px-2">
            {!runs.length && <p className="px-2 text-sm text-muted-foreground">No imports yet.</p>}
            <ul className="divide-y">
              {runs.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setOpenId(r.id)}
                    className={cn('flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-muted', reportId === r.id && 'bg-muted')}>
                    {r.source === 'drive' ? <GoogleDriveLogo size={18} className="shrink-0" /> : <FileZip size={18} className="shrink-0" />}
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-bold">{r.source === 'drive' ? 'Drive sync' : 'Zip import'} · {formatDistanceToNow(new Date(r.started_at), { addSuffix: true })}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {r.status === 'running'
                          ? `Running… ${r.stats?.seen ?? 0}/${r.stats?.total ?? '?'} files`
                          : r.status === 'failed' ? r.error
                            : `${r.stats.added} new · ${r.stats.updated} changed · ${r.stats.removed} removed · ${r.stats.sendable} sendable`}
                        {r.triggered_by_name ? ` · by ${r.triggered_by_name}` : ''}
                      </span>
                    </span>
                    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold capitalize', STATUS[r.status])}>{r.status}</span>
                    <CaretRight size={14} className="text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      {reportId && <RunReport id={reportId} />}
    </div>
  );
}

function RunReport({ id }) {
  const { data: run } = useQuery({ queryKey: ['gallery', 'run', id], queryFn: async () => (await api.get(`/gallery/runs/${id}`)).data.run });
  if (!run) return null;
  const s = run.stats || {};
  const r = run.report || {};
  return (
    <Card>
      <CardHeader>
        <CardTitle>Import report</CardTitle>
        <CardDescription>{format(new Date(run.started_at), 'd MMM yyyy, h:mm a')} · {run.source === 'drive' ? 'Google Drive' : 'zip file'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[['Files', s.total], ['Sent by the bot', s.sendable], ['No design name', s.generic], ['Needs a price', s.unpriced]].map(([k, v]) => (
            <div key={k} className="rounded-lg bg-muted px-3 py-2">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="text-xl font-extrabold">{v ?? '—'}</dd>
            </div>
          ))}
        </dl>
        {run.error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{run.error}</p>}
        <PathList title="Needs a price" hint="Add a price to the file or folder name in Drive, e.g. “Unicorn Ring (6k-7k)”." paths={r.unpriced} />
        <PathList title="No design name" hint="Renaming these in Drive as “Design Name (8k-10k)” makes them sendable." paths={r.generic} />
        <PathList title="Not in a known category" hint="The top folder doesn't match a design category in Pricing & Rules." paths={r.no_category} />
        <PathList title="Errors" paths={(r.errors || []).map((e) => `${e.path}: ${e.error}`)} />
        <PathList title="Skipped (not images)" paths={r.skipped} />
      </CardContent>
    </Card>
  );
}

function PathList({ title, hint, paths }) {
  const [open, setOpen] = useState(false);
  if (!paths?.length) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(paths.join('\n')); toast.success('Copied the list'); } catch { toast.error('Could not copy'); }
  };
  return (
    <section className="rounded-lg border">
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex flex-1 items-center gap-2 text-left" aria-expanded={open}>
          <CaretRight size={14} className={cn('transition-transform', open && 'rotate-90')} />
          <span className="text-sm font-bold">{title}</span>
          <span className="rounded-full bg-muted px-2 text-xs font-bold">{paths.length}</span>
        </button>
        <Button size="sm" variant="ghost" onClick={copy}><Copy size={14} /> Copy</Button>
      </div>
      {hint && <p className="px-3 pb-2 text-xs text-muted-foreground">{hint}</p>}
      {open && (
        <ul className="max-h-72 overflow-y-auto border-t px-3 py-2 font-mono text-xs leading-6">
          {paths.map((p) => <li key={p} className="truncate" title={p}>{p}</li>)}
        </ul>
      )}
    </section>
  );
}
