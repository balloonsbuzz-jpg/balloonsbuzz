import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ChatsCircle } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import ConversationList from './ConversationList';
import Thread from './Thread';
import DetailsPanel from './DetailsPanel';

/** Whapter-style three-column inbox: list · thread · customer details. */
export default function InboxPage() {
  const { id } = useParams();
  const [showDetails, setShowDetails] = useState(false);
  return (
    // Full-bleed route (AppLayout drops its page container for /inbox).
    <div className="flex h-[calc(100dvh-3.5rem)] overflow-hidden bg-background lg:h-dvh">
      <div className={cn('w-full shrink-0 border-r bg-card md:w-80 lg:w-96', id && 'hidden md:block')}>
        <ConversationList activeId={id} />
      </div>
      <div className={cn('min-w-0 flex-1', !id && 'hidden md:block')}>
        {id ? <Thread key={id} id={id} onToggleDetails={() => setShowDetails((s) => !s)} /> : (
          <div className="flex h-full flex-col items-center justify-center p-8 text-center text-muted-foreground">
            <ChatsCircle size={48} weight="duotone" className="mb-3 text-primary" />
            <p className="font-bold text-foreground">Select a conversation</p>
            <p className="mt-1 max-w-xs text-sm">Chats marked <b className="text-destructive">Needs human</b> are waiting for your team.</p>
          </div>
        )}
      </div>
      {id && (
        <div className={cn('w-80 shrink-0', showDetails ? 'fixed inset-y-0 right-0 z-40 shadow-xl xl:static xl:shadow-none' : 'hidden xl:block')}>
          <DetailsPanel id={id} onClose={() => setShowDetails(false)} />
        </div>
      )}
    </div>
  );
}
