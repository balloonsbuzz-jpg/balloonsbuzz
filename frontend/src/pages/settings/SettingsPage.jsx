import { useState } from 'react';
import { PageHeader } from '@/components/layout/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import WhatsAppSettings from './WhatsAppSettings';
import BusinessSettings from './BusinessSettings';

export default function SettingsPage() {
  const [tab, setTab] = useState('whatsapp');
  return (
    <>
      <PageHeader title="Settings" description="Connect the WhatsApp number and manage business details." />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 w-full max-w-md">
          <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
          <TabsTrigger value="business">Business</TabsTrigger>
        </TabsList>
        <TabsContent value="whatsapp"><WhatsAppSettings /></TabsContent>
        <TabsContent value="business"><BusinessSettings /></TabsContent>
      </Tabs>
    </>
  );
}
