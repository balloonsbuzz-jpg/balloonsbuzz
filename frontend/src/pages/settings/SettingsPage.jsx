import { useState } from 'react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import WhatsAppSettings from './WhatsAppSettings';

export default function SettingsPage() {
  const [tab, setTab] = useState('whatsapp');
  return (
    <>
      <PageHeader title="Settings" description="Connect the WhatsApp number and manage business details." />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 w-full max-w-md">
          <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
          <TabsTrigger value="business" disabled title="Base location, advance %, working hours: arrives with pricing (M5)">Business</TabsTrigger>
        </TabsList>
        <TabsContent value="whatsapp"><WhatsAppSettings /></TabsContent>
      </Tabs>
    </>
  );
}
