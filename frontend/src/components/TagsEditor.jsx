import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { X } from '@phosphor-icons/react';
import { api, errorMessage } from '@/lib/api';

/** Tags on a contact (used for broadcast audiences). Type a name and press Enter to add. */
export default function TagsEditor({ contactId, canWrite = true }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const { data: tags = [] } = useQuery({ queryKey: ['contact-tags', contactId], enabled: !!contactId, queryFn: async () => (await api.get(`/contacts/${contactId}/tags`)).data.tags });
  const { data: all = [] } = useQuery({ queryKey: ['tags'], queryFn: async () => (await api.get('/tags')).data.tags, staleTime: 30_000 });
  const save = useMutation({
    mutationFn: async (names) => (await api.put(`/contacts/${contactId}/tags`, { names })).data.tags,
    onSuccess: (t) => { qc.setQueryData(['contact-tags', contactId], t); qc.invalidateQueries({ queryKey: ['tags'] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const names = tags.map((t) => t.name);
  const add = (n) => {
    const v = n.trim();
    if (v && !names.some((x) => x.toLowerCase() === v.toLowerCase())) save.mutate([...names, v]);
    setDraft('');
  };
  const listId = `tag-suggestions-${contactId}`;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <span key={t.id} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold text-white" style={{ backgroundColor: t.color }}>
          {t.name}
          {canWrite && <button type="button" aria-label={`Remove tag ${t.name}`} className="opacity-75 hover:opacity-100" onClick={() => save.mutate(names.filter((x) => x !== t.name))}><X size={11} weight="bold" /></button>}
        </span>
      ))}
      {canWrite && (
        <>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} list={listId} maxLength={40}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft); } }} onBlur={() => draft && add(draft)}
            placeholder="+ tag" aria-label="Add a tag"
            className="w-24 rounded-full border border-dashed bg-transparent px-2.5 py-0.5 text-xs outline-none focus:border-ring" />
          <datalist id={listId}>{all.filter((t) => !names.includes(t.name)).map((t) => <option key={t.id} value={t.name} />)}</datalist>
        </>
      )}
      {!tags.length && !canWrite && <span className="text-xs text-muted-foreground">No tags</span>}
    </div>
  );
}
