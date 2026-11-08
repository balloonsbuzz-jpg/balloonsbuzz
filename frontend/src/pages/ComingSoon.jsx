import { useLocation } from 'react-router-dom';
import { Balloon } from '@phosphor-icons/react';
import { ALL_ITEMS } from '@/nav';
import { PageHeader } from '@/components/layout/AppLayout';

const WHAT = {
  M2b: 'Invite team members, assign roles, and browse every change in the audit log.',
  M3: 'Connect the WhatsApp number (Meta Cloud API) and business details such as the base location and advance %.',
  M4: 'Shared inbox with live updates and Take over / Pause / Resume bot controls.',
  M5: 'Drive-synced photo gallery, prices, discount limits and distance slabs.',
  M7: 'Leads with qualification details and the bookings board with advance tracking.',
  M8: 'WhatsApp templates, broadcasts, and automatic follow-ups and reminders.',
  M9: 'Leads, conversions, bookings, revenue, handover rate and AI cost.',
};

export default function ComingSoon() {
  const { pathname } = useLocation();
  const item = ALL_ITEMS.find((i) => pathname.startsWith(i.to));
  return (
    <>
      <PageHeader title={item?.label || 'Coming soon'} />
      <div className="flex flex-col items-center rounded-2xl border border-dashed bg-card px-6 py-16 text-center">
        <Balloon size={44} weight="duotone" className="text-primary" />
        <p className="mt-4 text-lg font-bold">Coming in milestone {item?.milestone}</p>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{WHAT[item?.milestone] || 'This screen is on the build plan.'}</p>
      </div>
    </>
  );
}
