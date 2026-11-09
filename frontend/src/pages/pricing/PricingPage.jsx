import { useState } from 'react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PackagesTab from './PackagesTab';
import ThemesTab from './ThemesTab';
import NegotiationTab from './NegotiationTab';
import DistanceTab from './DistanceTab';
import QuoteTab from './QuoteTab';

const TABS = [
  ['prices', 'Design prices', PackagesTab],
  ['negotiation', 'Discount limits', NegotiationTab],
  ['distance', 'Distance', DistanceTab],
  ['themes', 'Themes', ThemesTab],
  ['quote', 'Quote calculator', QuoteTab],
];

export default function PricingPage() {
  const [tab, setTab] = useState('prices');
  return (
    <>
      <PageHeader
        title="Pricing & Rules"
        description="The AI never makes up a price: every quote comes from these numbers, and it can’t discount below the limits set here."
      />
      <Tabs value={tab} onValueChange={setTab}>
        <div className="-mx-1 mb-4 overflow-x-auto px-1">
          <TabsList className="w-max min-w-full sm:min-w-0">
            {TABS.map(([k, label]) => <TabsTrigger key={k} value={k}>{label}</TabsTrigger>)}
          </TabsList>
        </div>
        {TABS.map(([k, , C]) => <TabsContent key={k} value={k}><C /></TabsContent>)}
      </Tabs>
    </>
  );
}
