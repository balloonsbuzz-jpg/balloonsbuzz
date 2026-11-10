import { useEffect, useState } from 'react';
import { NavLink, useSearchParams } from 'react-router-dom';
import { MagnifyingGlass, Robot, User, Pause, HandWaving } from '@phosphor-icons/react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useConversations, useCounts } from './useInbox';
import { shortTime, displayName } from './format';

const FILTERS = [
  ['all', 'All'], ['needs_human', 'Needs human'], ['mine', 'Mine'], ['unread', 'Unread'], ['bot', 'Bot'], ['human', 'Human'], ['closed', 'Closed'],
];

export function ModeBadge({ mode, className }) {
  const map = {
    bot: ['Bot', Robot, 'bg-accent text-accent-foreground'],
    human: ['Human', User, 'bg-primary/10 text-primary'],
    paused: ['Paused', Pause, 'bg-muted text-muted-foreground'],
  };
  const [label, Icon, cls] = map[mode] || map.bot;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-px text-[11px] font-bold', cls, className)}>
      <Icon size={11} weight="bold" /> {label}
    </span>
  );
}

export default function ConversationList({ activeId }) {
  const [params] = useSearchParams();
  const [filter, setFilter] = useState(() => (FILTERS.some(([k]) => k === params.get('filter')) ? params.get('filter') : 'all'));
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => { const t = setTimeout(() => setSearch(input.trim()), 300); return () => clearTimeout(t); }, [input]);
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useConversations(filter, search);
  const { data: counts } = useCounts();
  const rows = data?.pages.flatMap((p) => p.conversations) || [];

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b p-3">
        <div className="relative">
          <MagnifyingGlass size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search conversations" placeholder="Search name or number" value={input} onChange={(e) => setInput(e.target.value)} className="h-9 pl-8" />
        </div>
        <div className="-mx-1 flex gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Filter conversations">
          {FILTERS.map(([key, label]) => {
            const n = key === 'needs_human' ? counts?.needs_human : key === 'unread' ? counts?.unread : key === 'mine' ? counts?.mine : null;
            return (
              <button key={key} role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}
                className={cn('shrink-0 rounded-full px-2.5 py-1 text-xs font-bold transition-colors',
                  filter === key ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground',
                  key === 'needs_human' && n > 0 && filter !== key && 'bg-destructive/10 text-destructive')}>
                {label}{n ? ` ${n}` : ''}
              </button>
            );
          })}
        </div>
      </div>

      <ul className="flex-1 overflow-y-auto" aria-label="Conversations">
        {isLoading && <li className="p-4 text-sm text-muted-foreground">Loading…</li>}
        {!isLoading && rows.length === 0 && (
          <li className="flex flex-col items-center p-8 text-center text-sm text-muted-foreground">
            <HandWaving size={32} weight="duotone" className="mb-2 text-primary" />
            {search ? 'No matches.' : filter === 'needs_human' ? 'Nobody is waiting for a human. 🎉' : 'No conversations yet. They appear here as customers message on WhatsApp.'}
          </li>
        )}
        {rows.map((c) => (
          <li key={c.id}>
            <NavLink to={`/inbox/${c.id}`}
              className={cn('flex gap-3 border-b px-3 py-3 transition-colors hover:bg-muted/60',
                c.id === activeId && 'bg-primary/5', c.needs_human && 'border-l-4 border-l-destructive pl-2')}>
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-rose-50 font-extrabold text-primary">
                {(displayName(c)[0] || '#').toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className={cn('flex-1 truncate text-sm', c.unread_count ? 'font-extrabold' : 'font-bold')}>{displayName(c)}</p>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{shortTime(c.last_message_at)}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <p className={cn('flex-1 truncate text-xs', c.unread_count ? 'text-foreground' : 'text-muted-foreground')}>
                    {c.last_message_direction === 'outbound' && <span className="text-muted-foreground">You: </span>}
                    {c.last_message_preview || '—'}
                  </p>
                  {c.unread_count > 0 && <span className="rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground">{c.unread_count}</span>}
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <ModeBadge mode={c.handling_mode} />
                  {c.needs_human && <span className="rounded-full bg-destructive/10 px-2 py-px text-[11px] font-bold text-destructive">Needs human</span>}
                  {c.assigned_user_name && <span className="truncate text-[11px] text-muted-foreground">· {c.assigned_user_name}</span>}
                </div>
              </div>
            </NavLink>
          </li>
        ))}
        {hasNextPage && (
          <li className="p-3 text-center">
            <button className="text-sm font-bold text-primary" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
              {isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
