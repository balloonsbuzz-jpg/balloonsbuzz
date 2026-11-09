import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle, XCircle, ArrowCounterClockwise, FolderSimple } from '@phosphor-icons/react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { NativeSelect } from '@/components/ui/native-select';
import { Field } from '@/pages/ai/fields';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { useCatalog, catalogOptions } from '@/hooks/useCatalog';
import { priceRange } from '@/lib/money';

const EMPTY = { title: '', package_id: null, theme_id: null, occasion_id: null, price_min: '', price_max: '', hidden: false, force: false };

export default function PhotoSheet({ id, onClose }) {
  const { can } = useAuth();
  const canWrite = can('gallery:write');
  const qc = useQueryClient();
  const { data: catalog } = useCatalog();
  const opts = catalogOptions(catalog);
  const { data } = useQuery({ queryKey: ['gallery', 'item', id], enabled: !!id, queryFn: async () => (await api.get(`/gallery/items/${id}`)).data.item });
  const [form, setForm] = useState(EMPTY);

  useEffect(() => {
    if (!data) return;
    setForm({
      title: data.override_title ?? '',
      package_id: data.override_package_id, theme_id: data.override_theme_id, occasion_id: data.override_occasion_id,
      price_min: data.override_price_min == null ? '' : Number(data.override_price_min),
      price_max: data.override_price_max == null ? '' : Number(data.override_price_max),
      hidden: data.override_hidden, force: data.override_force_sendable,
    });
  }, [data]);

  const save = useMutation({
    mutationFn: async (body) => (await api.patch(`/gallery/items/${id}`, body)).data.item,
    onSuccess: (item) => {
      qc.setQueryData(['gallery', 'item', id], item);
      qc.invalidateQueries({ queryKey: ['gallery'] });
      toast.success(item.is_sendable ? 'Saved. The bot can send this photo.' : 'Saved.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v?.target ? v.target.value : v }));
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const submit = (e) => {
    e.preventDefault();
    save.mutate({
      override_title: form.title.trim() || null,
      override_package_id: form.package_id, override_theme_id: form.theme_id, override_occasion_id: form.occasion_id,
      override_price_min: num(form.price_min), override_price_max: num(form.price_max) ?? num(form.price_min),
      override_hidden: form.hidden, override_force_sendable: form.force,
    });
  };
  const resetAll = () => save.mutate({
    override_title: null, override_package_id: null, override_theme_id: null, override_occasion_id: null,
    override_price_min: null, override_price_max: null, override_hidden: false, override_force_sendable: false,
  });

  const parsedName = (list, pid) => list.find(([v]) => v === pid)?.[1];
  const d = data;

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-lg">
        {!d ? <p className="p-6 text-sm text-muted-foreground">Loading…</p> : (
          <>
            <SheetHeader className="pr-12">
              <SheetTitle className="text-lg font-extrabold">{d.title || 'Untitled photo'}</SheetTitle>
              <SheetDescription className="flex items-start gap-1.5 break-all"><FolderSimple size={15} className="mt-0.5 shrink-0" /> {d.source_path}</SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-4 pb-6">
              <a href={d.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border bg-muted">
                <img src={d.url} alt={d.title || 'Decoration photo'} className="max-h-[50vh] w-full object-contain" />
              </a>

              <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${d.is_sendable ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}>
                {d.is_sendable ? <CheckCircle size={18} weight="fill" className="shrink-0" /> : <XCircle size={18} weight="fill" className="shrink-0" />}
                <span className="font-bold">
                  {d.is_sendable ? `The bot can send this: “${d.title}”, ${priceRange(d.price_min, d.price_max)}`
                    : !d.is_present_in_source ? 'Not sent: the file was removed from Drive.'
                      : d.override_hidden ? 'Not sent: hidden.'
                        : d.name_quality === 'generic' && !d.override_force_sendable ? 'Not sent: the file name doesn’t say what the design is.'
                          : 'Not sent: no price yet.'}
                </span>
              </div>

              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">From Drive</dt>
                <dd>{d.parsed_title || <i>no design name</i>} · {d.parsed_price_min != null ? `${priceRange(d.parsed_price_min, d.parsed_price_max)} (from ${d.parsed_price_source === 'filename' ? 'file name' : 'folder'})` : 'no price'}</dd>
                <dt className="text-muted-foreground">Category</dt>
                <dd>{parsedName(opts.packages, d.parsed_package_id) || '—'}{d.style ? ` · ${d.style.replace(/_/g, ' ')}` : ''}</dd>
                <dt className="text-muted-foreground">Theme / occasion</dt>
                <dd>{[parsedName(opts.themes, d.parsed_theme_id), parsedName(opts.occasions, d.parsed_occasion_id)].filter(Boolean).join(' · ') || '—'}</dd>
                <dt className="text-muted-foreground">Size</dt>
                <dd>{d.width}×{d.height}, {Math.round(d.size_bytes / 1024)} KB</dd>
              </dl>

              <form onSubmit={submit} className="space-y-4 rounded-xl border p-4">
                <div>
                  <h3 className="font-extrabold">Corrections</h3>
                  <p className="text-xs text-muted-foreground">Leave a field empty to use what Drive says. Corrections are kept when Drive syncs again.</p>
                </div>
                <fieldset disabled={!canWrite} className="space-y-4">
                  <Field id="ov-title" label="Design name" hint="Shown to the customer in the photo caption">
                    <Input id="ov-title" value={form.title} onChange={set('title')} placeholder={d.parsed_title || 'e.g. Unicorn Ring Decor'} maxLength={120} />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field id="ov-min" label="Price from (₹)">
                      <Input id="ov-min" type="number" inputMode="numeric" min={0} step={100} value={form.price_min} onChange={set('price_min')} placeholder={d.parsed_price_min != null ? String(Number(d.parsed_price_min)) : ''} />
                    </Field>
                    <Field id="ov-max" label="Price to (₹)">
                      <Input id="ov-max" type="number" inputMode="numeric" min={0} step={100} value={form.price_max} onChange={set('price_max')} placeholder={d.parsed_price_max != null ? String(Number(d.parsed_price_max)) : ''} />
                    </Field>
                  </div>
                  <Field id="ov-pkg" label="Design category">
                    <NativeSelect id="ov-pkg" value={form.package_id} onChange={set('package_id')} options={opts.packages} placeholder={`From Drive: ${parsedName(opts.packages, d.parsed_package_id) || 'none'}`} />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field id="ov-theme" label="Theme">
                      <NativeSelect id="ov-theme" value={form.theme_id} onChange={set('theme_id')} options={opts.themes} placeholder={`From Drive: ${parsedName(opts.themes, d.parsed_theme_id) || 'none'}`} />
                    </Field>
                    <Field id="ov-occ" label="Occasion">
                      <NativeSelect id="ov-occ" value={form.occasion_id} onChange={set('occasion_id')} options={opts.occasions} placeholder={`From Drive: ${parsedName(opts.occasions, d.parsed_occasion_id) || 'none'}`} />
                    </Field>
                  </div>
                  {d.name_quality === 'generic' && (
                    <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                      <span><span className="block text-sm font-bold">Send even without a design name</span><span className="text-xs text-muted-foreground">Only if you checked the photo is good to share. Give it a design name above.</span></span>
                      <Switch checked={form.force} onCheckedChange={set('force')} aria-label="Send even without a design name" />
                    </label>
                  )}
                  <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                    <span><span className="block text-sm font-bold">Hide from the bot</span><span className="text-xs text-muted-foreground">For example a photo with a child’s name or another vendor’s work</span></span>
                    <Switch checked={form.hidden} onCheckedChange={set('hidden')} aria-label="Hide from the bot" />
                  </label>
                </fieldset>
                {canWrite && (
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
                    {d.override_updated_at && (
                      <Button type="button" variant="ghost" onClick={resetAll} disabled={save.isPending}><ArrowCounterClockwise size={15} /> Use Drive values</Button>
                    )}
                  </div>
                )}
              </form>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
