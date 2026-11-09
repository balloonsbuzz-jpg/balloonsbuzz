import { useState } from 'react';
import { MagnifyingGlass, Plus, X } from '@phosphor-icons/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import { useCatalog } from '@/hooks/useCatalog';
import { useSave } from './shared';

export default function ThemesTab() {
  const { data: catalog, isLoading } = useCatalog();
  const { can } = useAuth();
  const canWrite = can('pricing:write');
  const [q, setQ] = useState('');
  const save = useSave([['catalog']], { success: null });
  const [name, setName] = useState('');
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const needle = q.trim().toLowerCase();
  const themes = catalog.themes.filter((t) => !needle || t.name.toLowerCase().includes(needle) || t.aliases.some((a) => a.alias.includes(needle)));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Themes</CardTitle>
        <CardDescription>
          Other words for each theme: typos in Drive folder names (“dinosour”) and how customers write (“spidey”). Adding one here lets both the photo import and the bot recognise it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-48 flex-1">
            <MagnifyingGlass size={16} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a theme or word…" className="pl-8" aria-label="Find a theme" />
          </div>
          {canWrite && (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate({ method: 'post', url: '/pricing/themes', body: { name: name.trim() } }, { onSuccess: () => setName('') }); }}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New theme name" aria-label="New theme name" className="w-48" />
              <Button type="submit" disabled={name.trim().length < 2 || save.isPending}><Plus size={15} /> Add theme</Button>
            </form>
          )}
        </div>
        <ul className="divide-y rounded-lg border">
          {themes.map((t) => <ThemeRow key={t.id} t={t} canWrite={canWrite} save={save} />)}
          {!themes.length && <li className="px-3 py-4 text-sm text-muted-foreground">No theme matches “{q}”.</li>}
        </ul>
      </CardContent>
    </Card>
  );
}

function ThemeRow({ t, canWrite, save }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const a = draft.trim();
    if (a.length < 2) return;
    save.mutate({ method: 'post', url: `/pricing/themes/${t.id}/aliases`, body: { alias: a } }, { onSuccess: () => setDraft('') });
  };
  return (
    <li className="grid gap-2 px-3 py-3 sm:grid-cols-[200px_minmax(0,1fr)]">
      <div>
        <p className="font-bold">{t.name}</p>
        <p className="text-xs text-muted-foreground">{t.sendable_photos} photo{t.sendable_photos === 1 ? '' : 's'}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {t.aliases.map((a) => (
          <span key={a.id} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-bold text-secondary-foreground">
            {a.alias}
            {canWrite && (
              <button type="button" aria-label={`Remove ${a.alias}`} className="opacity-60 hover:opacity-100" onClick={() => save.mutate({ method: 'delete', url: `/pricing/aliases/${a.id}` })}>
                <X size={11} weight="bold" />
              </button>
            )}
          </span>
        ))}
        {canWrite && (
          <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={add}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            placeholder="+ add word" aria-label={`Add a word for ${t.name}`}
            className="w-28 rounded-full border border-dashed bg-transparent px-2.5 py-0.5 text-xs outline-none focus:border-ring" />
        )}
      </div>
    </li>
  );
}
