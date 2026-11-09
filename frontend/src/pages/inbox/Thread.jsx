import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, HandPalm, Pause, Play, PaperPlaneRight, NotePencil, CaretDown, CheckCircle, ArrowCounterClockwise, Info } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import MessageBubble from './MessageBubble';
import { ModeBadge } from './ConversationList';
import { useConversation, useMessages, useConvAction, useCannedReplies } from './useInbox';
import { dayLabel, displayName, formatPhone, windowLeft } from './format';

const PAUSE_OPTIONS = [[30, '30 minutes'], [60, '1 hour'], [240, '4 hours'], [1440, '1 day'], [null, 'Until I resume']];

export default function Thread({ id, onToggleDetails }) {
  const { can } = useAuth();
  const { data: conv } = useConversation(id);
  const { data: messages = [], isLoading } = useMessages(id);
  const act = useConvAction(id);
  const scroller = useRef(null);

  // Opening a chat with unread messages marks it read (and sends blue ticks if enabled).
  useEffect(() => {
    if (conv?.unread_count > 0 && can('inbox:write')) act.mutate({ path: 'read' });
  }, [conv?.id, conv?.unread_count]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, id]);

  if (!conv) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  const canHandover = can('handover:write');
  const mode = conv.handling_mode;

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* header */}
      <header className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-2.5">
        <Link to="/inbox" className="rounded-md p-1 hover:bg-muted md:hidden" aria-label="Back to conversations"><ArrowLeft size={20} /></Link>
        <div className="min-w-0 flex-1">
          <p className="truncate font-extrabold">{displayName(conv)}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span>{formatPhone(conv.contact_phone)}</span>
            <ModeBadge mode={mode} />
            {conv.needs_human && <span className="font-bold text-destructive">Needs human</span>}
            {mode === 'paused' && conv.bot_resume_at && <span>Bot resumes {new Date(conv.bot_resume_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {canHandover && mode === 'bot' && (
            <Button size="sm" onClick={() => act.mutate({ path: 'takeover' })} disabled={act.isPending}>
              <HandPalm size={15} /> Take over
            </Button>
          )}
          {canHandover && mode !== 'bot' && (
            <Button size="sm" variant="secondary" onClick={() => act.mutate({ path: 'resume' })} disabled={act.isPending}>
              <Play size={15} /> Resume bot
            </Button>
          )}
          {canHandover && mode !== 'paused' && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
                <Pause size={15} /> Pause bot <CaretDown size={12} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {PAUSE_OPTIONS.map(([mins, label]) => (
                  <DropdownMenuItem key={label} onClick={() => act.mutate({ path: 'pause', body: mins ? { resume_in_minutes: mins } : {} })}>
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {can('inbox:write') && (conv.status === 'closed'
            ? <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: 'reopen' })}><ArrowCounterClockwise size={15} /> Reopen</Button>
            : <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: 'close' })}><CheckCircle size={15} /> Close</Button>)}
          <Button size="icon-sm" variant="ghost" className="xl:hidden" aria-label="Customer details" onClick={onToggleDetails}><Info size={18} /></Button>
        </div>
      </header>

      {/* messages */}
      <div ref={scroller} className="flex-1 space-y-2 overflow-y-auto bg-[radial-gradient(circle_at_1px_1px,rgba(180,86,106,0.07)_1px,transparent_0)] bg-[length:18px_18px] px-3 py-4 sm:px-6">
        {isLoading && <p className="text-center text-sm text-muted-foreground">Loading messages…</p>}
        <MessageList messages={messages} />
      </div>

      {can('inbox:write') && <Composer conv={conv} act={act} />}
    </div>
  );
}

function MessageList({ messages }) {
  let lastDay = null;
  return messages.map((m) => {
    const day = new Date(m.created_at).toDateString();
    const showDay = day !== lastDay;
    lastDay = day;
    return (
      <Fragment key={m.id}>
        {showDay && <div className="sticky top-0 z-10 py-1 text-center"><span className="rounded-full bg-card px-3 py-0.5 text-[11px] font-bold text-muted-foreground shadow-sm ring-1 ring-border">{dayLabel(m.created_at)}</span></div>}
        <MessageBubble m={m} />
      </Fragment>
    );
  });
}

function Composer({ conv, act }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState(false);
  const { data: canned = [] } = useCannedReplies();
  const left = windowLeft(conv.window_expires_at);
  const windowClosed = !note && !conv.window_open;

  const slash = text.startsWith('/') ? text.slice(1).toLowerCase() : null;
  const suggestions = useMemo(
    () => (slash == null ? [] : canned.filter((c) => c.shortcut.includes(slash) || c.title.toLowerCase().includes(slash)).slice(0, 6)),
    [slash, canned],
  );

  function send() {
    const t = text.trim();
    if (!t || act.isPending || windowClosed) return;
    act.mutate({ path: 'messages', body: { text: t, ...(note ? { as_note: true } : {}) } }, { onSuccess: () => setText('') });
  }

  return (
    <div className={cn('border-t bg-card p-3', note && 'bg-amber-50 dark:bg-amber-950/20')}>
      {suggestions.length > 0 && (
        <ul className="mb-2 overflow-hidden rounded-lg border bg-popover shadow-md" role="listbox" aria-label="Quick replies">
          {suggestions.map((c) => (
            <li key={c.id}>
              <button type="button" className="flex w-full gap-2 px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => setText(c.body)}>
                <span className="font-mono text-xs font-bold text-primary">/{c.shortcut}</span>
                <span className="truncate text-muted-foreground">{c.body}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {windowClosed ? (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          The 24-hour reply window is closed: the customer hasn’t messaged in a day. WhatsApp only allows approved templates now (Templates arrive in M8). You can still add an internal note.
          <button className="ml-1 font-bold text-primary" onClick={() => setNote(true)}>Add note</button>
        </p>
      ) : (
        <div className="flex items-end gap-2">
          <textarea
            aria-label={note ? 'Internal note' : 'Message'}
            rows={Math.min(6, Math.max(1, text.split('\n').length))}
            value={text}
            maxLength={4096}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={note ? 'Internal note (only your team sees this)…' : 'Type a reply… ( / for quick replies, Shift+Enter for a new line)'}
            className="max-h-40 min-h-10 flex-1 resize-none rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-3 focus:ring-ring/40"
          />
          <Button size="lg" onClick={send} disabled={!text.trim() || act.isPending} aria-label={note ? 'Save note' : 'Send'} className="h-10">
            {note ? <NotePencil size={18} /> : <PaperPlaneRight size={18} weight="fill" />}
          </Button>
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground">
        <label className="flex cursor-pointer items-center gap-1 font-bold">
          <input type="checkbox" checked={note} onChange={(e) => setNote(e.target.checked)} className="accent-[var(--primary)]" /> Internal note
        </label>
        {!note && conv.handling_mode === 'bot' && conv.window_open && <span>Sending a reply takes over from the bot.</span>}
        {!note && left && <span className="ml-auto">Reply window: {left}</span>}
      </div>
    </div>
  );
}
