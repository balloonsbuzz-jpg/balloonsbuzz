import { format } from 'date-fns';
import { Check, Checks, Clock, WarningCircle, Robot, MapPin, FileText, ArrowBendUpLeft, NotePencil } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';

function Ticks({ status, error }) {
  if (status === 'failed') {
    return <span title={error || 'Not delivered'} className="inline-flex items-center gap-0.5 text-destructive"><WarningCircle size={14} weight="fill" /> Failed</span>;
  }
  if (status === 'queued' || status === 'sending') return <Clock size={13} aria-label="Sending" />;
  if (status === 'sent') return <Check size={14} weight="bold" aria-label="Sent" />;
  if (status === 'delivered') return <Checks size={15} weight="bold" aria-label="Delivered" />;
  if (status === 'read') return <Checks size={15} weight="bold" className="text-sky-500" aria-label="Read" />;
  return null;
}

function Media({ m }) {
  const src = `/api/media/${m.media_id}`;
  if (m.message_type === 'image' || m.message_type === 'sticker') {
    return (
      <a href={src} target="_blank" rel="noreferrer">
        <img src={src} alt={m.body || 'Photo from customer'} loading="lazy" className="max-h-72 w-full rounded-lg bg-muted object-cover" />
      </a>
    );
  }
  if (m.message_type === 'video') return <video src={src} controls preload="metadata" className="max-h-72 w-full rounded-lg bg-black" />;
  if (m.message_type === 'audio') return <audio src={src} controls preload="none" className="w-60 max-w-full" />;
  return (
    <a href={src} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg bg-background/60 px-3 py-2 text-sm font-bold underline-offset-2 hover:underline">
      <FileText size={18} /> {m.media_filename || 'Document'}
    </a>
  );
}

function Content({ m }) {
  if (m.media_id) {
    return <div className="space-y-1.5"><Media m={m} />{m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}</div>;
  }
  if (m.message_type === 'location' && m.payload?.latitude != null) {
    const q = `${m.payload.latitude},${m.payload.longitude}`;
    return (
      <a href={`https://www.google.com/maps?q=${q}`} target="_blank" rel="noreferrer" className="flex items-start gap-2 hover:underline">
        <MapPin size={20} weight="fill" className="mt-0.5 shrink-0 text-primary" />
        <span><b>{m.payload.name || 'Location pin'}</b>{m.payload.address && <span className="block text-xs opacity-80">{m.payload.address}</span>}
          <span className="block text-[11px] opacity-60">{q}</span></span>
      </a>
    );
  }
  if ((m.message_type === 'interactive' || m.message_type === 'button') && m.direction === 'inbound') {
    return <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 font-bold text-primary">↩ {m.body}</span>;
  }
  if (m.message_type === 'unsupported') return <p className="italic opacity-70">This message type isn’t supported yet.</p>;
  return <p className="whitespace-pre-wrap break-words">{m.body}</p>;
}

export default function MessageBubble({ m }) {
  if (m.message_type === 'reaction') {
    return <div className={cn('flex', m.direction === 'inbound' ? 'justify-start' : 'justify-end')}><span className="text-xl" title="Reaction">{m.body}</span></div>;
  }
  if (m.is_internal_note) {
    return (
      <div className="mx-auto max-w-lg rounded-lg border border-dashed border-amber-400/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        <p className="mb-0.5 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide opacity-70"><NotePencil size={12} /> Internal note · {m.sender_name}</p>
        <p className="whitespace-pre-wrap">{m.body}</p>
      </div>
    );
  }
  const inbound = m.direction === 'inbound';
  const who = inbound ? null : m.sender_type === 'bot' ? 'Bot' : m.sender_type === 'system' ? 'Auto' : m.sender_name || 'Team';
  return (
    <div className={cn('flex', inbound ? 'justify-start' : 'justify-end')}>
      <div className={cn('max-w-[78%] rounded-2xl px-3 py-2 text-sm shadow-sm',
        inbound && 'rounded-bl-md bg-card ring-1 ring-border',
        m.sender_type === 'agent' && 'rounded-br-md bg-primary text-primary-foreground',
        (m.sender_type === 'bot' || m.sender_type === 'system') && 'rounded-br-md bg-accent text-accent-foreground ring-1 ring-brand-gold-200',
        m.status === 'failed' && 'ring-2 ring-destructive/60')}>
        {who && (
          <p className="mb-0.5 flex items-center gap-1 text-[11px] font-bold opacity-75">
            {m.sender_type === 'bot' && <Robot size={12} weight="bold" />}{who}
          </p>
        )}
        {m.reply_to_message_id && (
          <div className={cn('mb-1.5 flex gap-1 rounded-md border-l-2 px-2 py-1 text-xs opacity-80', inbound ? 'border-primary bg-muted' : 'border-current bg-black/10')}>
            <ArrowBendUpLeft size={12} className="mt-0.5 shrink-0" />
            <span className="line-clamp-2">{m.reply_to_body || (m.reply_to_type === 'image' ? '📷 Photo' : 'Message')}</span>
          </div>
        )}
        <Content m={m} />
        <div className={cn('mt-1 flex items-center justify-end gap-1 text-[11px]', inbound ? 'text-muted-foreground' : 'opacity-80')}>
          <span>{format(new Date(m.created_at), 'h:mm a')}</span>
          {!inbound && <Ticks status={m.status} error={m.error_message} />}
        </div>
        {m.status === 'failed' && m.error_message && <p className="mt-1 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">{m.error_message}</p>}
      </div>
    </div>
  );
}
