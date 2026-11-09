import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MagnifyingGlass, ArrowsClockwise, EyeSlash, Warning, PencilSimple, GoogleDriveLogo, ImageBroken } from '@phosphor-icons/react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { useCatalog, catalogOptions } from '@/hooks/useCatalog';
import { priceShort } from '@/lib/money';
import { cn } from '@/lib/utils';
import PhotoSheet from './PhotoSheet';
import ImportsPanel from './ImportsPanel';
import PickerPanel from './PickerPanel';

const FILTERS = [
  ['all', 'All'],
  ['sendable', 'Sent by the bot'],
  ['needs_price', 'Needs a price'],
  ['generic', 'No design name'],
  ['hidden', 'Hidden'],
  ['removed', 'Removed from Drive'],
];
const PAGE = 60;

export function useGalleryConfig() {
  return useQuery({ queryKey: ['gallery', 'config'], queryFn: async () => (await api.get('/gallery/config')).data, staleTime: 60_000 });
}

export default function GalleryPage() {
  const [tab, setTab] = useState('photos');
  const { can } = useAuth();
  const { data: config } = useGalleryConfig();
  const qc = useQueryClient();
  const sync = useMutation({
    mutationFn: async () => (await api.post('/gallery/sync')).data,
    onSuccess: () => { toast.success('Drive sync started. New and renamed photos appear in a minute or two.'); qc.invalidateQueries({ queryKey: ['gallery'] }); setTab('imports'); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <>
      <PageHeader
        title="Gallery"
        description="Decoration photos from the Google Drive folder. The bot only sends a photo when its name says what the design is and it has a price."
        actions={can('gallery:write') && (
          <Button variant="outline" onClick={() => sync.mutate()} disabled={!config?.drive_connected || sync.isPending}
            title={config?.drive_connected ? 'Fetch new, renamed and deleted photos from Drive now' : 'Google Drive is not connected yet (API key needed)'}>
            <ArrowsClockwise size={16} className={cn(sync.isPending && 'animate-spin')} /> Sync from Drive
          </Button>
        )}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 w-full max-w-md">
          <TabsTrigger value="photos">Photos</TabsTrigger>
          <TabsTrigger value="picker">What the bot sends</TabsTrigger>
          <TabsTrigger value="imports">Imports</TabsTrigger>
        </TabsList>
        <TabsContent value="photos"><Photos config={config} /></TabsContent>
        <TabsContent value="picker"><PickerPanel /></TabsContent>
        <TabsContent value="imports"><ImportsPanel config={config} /></TabsContent>
      </Tabs>
    </>
  );
}

function Photos({ config }) {
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [packageId, setPackageId] = useState(null);
  const [themeId, setThemeId] = useState(null);
  const [openId, setOpenId] = useState(null);
  const { data: catalog } = useCatalog();
  const opts = catalogOptions(catalog);

  const { data: stats } = useQuery({ queryKey: ['gallery', 'stats'], queryFn: async () => (await api.get('/gallery/stats')).data });
  const list = useInfiniteQuery({
    queryKey: ['gallery', 'items', status, q, packageId, themeId],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => (await api.get('/gallery/items', {
      params: { status, q: q || undefined, package_id: packageId || undefined, theme_id: themeId || undefined, limit: PAGE, offset: pageParam },
    })).data,
    getNextPageParam: (last, pages) => (pages.length * PAGE < last.total ? pages.length * PAGE : undefined),
  });
  const items = list.data?.pages.flatMap((p) => p.items) || [];
  const total = list.data?.pages[0]?.total ?? 0;

  if (stats && stats.all === 0 && status === 'all' && !q) return <EmptyGallery config={config} />;

  return (
    <div className="space-y-4">
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Filter photos">
        {FILTERS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={status === k} onClick={() => setStatus(k)}
            className={cn('shrink-0 rounded-full border px-3 py-1 text-sm font-bold transition-colors',
              status === k ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-foreground/80 hover:bg-muted')}>
            {label}{stats && <span className={cn('ml-1.5 font-semibold', status === k ? 'opacity-80' : 'text-muted-foreground')}>{stats[k]}</span>}
          </button>
        ))}
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_200px_200px]">
        <div className="relative">
          <MagnifyingGlass size={16} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or folder…" className="pl-8" aria-label="Search photos" />
        </div>
        <NativeSelect aria-label="Design category" value={packageId} onChange={setPackageId} options={opts.packages} placeholder="All categories" />
        <NativeSelect aria-label="Theme" value={themeId} onChange={setThemeId} options={opts.themes} placeholder="All themes" />
      </div>

      {status === 'generic' && (
        <p className="rounded-lg bg-accent/60 px-3 py-2 text-sm text-accent-foreground">
          These files are named like <code>WhatsApp Image …</code> or a code, so the bot can’t tell the design. Rename the good ones in Drive as <b>Design Name (8k-10k)</b>, or open a photo and choose “Send even without a design name”.
        </p>
      )}
      {status === 'needs_price' && (
        <p className="rounded-lg bg-accent/60 px-3 py-2 text-sm text-accent-foreground">
          These have a design name but no price in the file or folder name. Add one in Drive (e.g. <b>Unicorn Ring (6k-7k)</b>) or set it here.
        </p>
      )}

      <p className="text-sm text-muted-foreground" aria-live="polite">{list.isLoading ? 'Loading…' : `${total} photo${total === 1 ? '' : 's'}`}</p>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {items.map((it) => (
          <li key={it.id}>
            <PhotoCard item={it} onOpen={() => setOpenId(it.id)} />
          </li>
        ))}
      </ul>

      {list.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            {list.isFetchingNextPage ? 'Loading…' : `Show more (${total - items.length} left)`}
          </Button>
        </div>
      )}

      <PhotoSheet id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function PhotoCard({ item, onOpen }) {
  const why = !item.is_present_in_source ? ['Removed from Drive', ImageBroken]
    : item.override_hidden ? ['Hidden', EyeSlash]
      : !item.is_sendable && item.name_quality === 'generic' && !item.override_force_sendable ? ['No design name', Warning]
        : !item.is_sendable ? ['Needs a price', Warning] : null;
  const edited = item.override_updated_at;
  const WhyIcon = why?.[1];
  return (
    <button type="button" onClick={onOpen}
      className="group block w-full overflow-hidden rounded-xl border bg-card text-left shadow-xs transition hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
      <div className="relative aspect-square bg-muted">
        <img src={item.thumb_url} alt={item.title || 'Decoration photo'} loading="lazy" className={cn('size-full object-cover', why && 'opacity-60')} />
        {item.price_min != null && (
          <span className="absolute right-2 bottom-2 rounded-full bg-background/90 px-2 py-0.5 text-xs font-extrabold shadow-sm">{priceShort(item.price_min, item.price_max)}</span>
        )}
        {why && (
          <span className="absolute top-2 left-2 inline-flex items-center gap-1 rounded-full bg-background/90 px-2 py-0.5 text-[11px] font-bold text-destructive shadow-sm">
            <WhyIcon size={12} weight="bold" /> {why[0]}
          </span>
        )}
        {edited && <span className="absolute top-2 right-2 rounded-full bg-primary p-1 text-primary-foreground shadow-sm" title="Edited in the dashboard"><PencilSimple size={11} weight="bold" /></span>}
      </div>
      <div className="p-2.5">
        <p className="truncate text-sm font-bold">{item.title || <span className="font-semibold text-muted-foreground">{item.source_path.split('/').pop()}</span>}</p>
        <p className="truncate text-xs text-muted-foreground">{[item.package_name, item.theme_name].filter(Boolean).join(' · ') || 'No category'}</p>
      </div>
    </button>
  );
}

function EmptyGallery({ config }) {
  return (
    <div className="rounded-xl border border-dashed bg-card p-8 text-center">
      <GoogleDriveLogo size={40} className="mx-auto text-primary" />
      <h2 className="mt-3 text-lg font-extrabold">No photos yet</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        Import the Drive folder once from a zip ({config?.drive_connected ? 'or press “Sync from Drive”' : 'Drive sync starts when the API key is added'}):
      </p>
      <code className="mt-3 inline-block rounded-lg bg-muted px-3 py-2 text-xs">npm run gallery:import -- "path\to\DECORATION NEW PHOTOS.zip"</code>
    </div>
  );
}
