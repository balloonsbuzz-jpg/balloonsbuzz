import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import AppLayout from '@/components/layout/AppLayout';
import Login from '@/pages/Login';
import ComingSoon from '@/pages/ComingSoon';
import AgentPage from '@/pages/ai/AgentPage';
import TestChatPage from '@/pages/ai/TestChatPage';
import ToolsPage from '@/pages/ai/ToolsPage';
import SettingsPage from '@/pages/settings/SettingsPage';
import InboxPage from '@/pages/inbox/InboxPage';
import GalleryPage from '@/pages/gallery/GalleryPage';
import PricingPage from '@/pages/pricing/PricingPage';
import BookingsPage from '@/pages/bookings/BookingsPage';
import LeadsPage from '@/pages/leads/LeadsPage';
import TemplatesPage from '@/pages/marketing/TemplatesPage';
import BroadcastsPage from '@/pages/marketing/BroadcastsPage';
import FollowupsPage from '@/pages/marketing/FollowupsPage';
import DashboardPage from '@/pages/analytics/DashboardPage';
import AnalyticsPage from '@/pages/analytics/AnalyticsPage';
import UsersPage from '@/pages/admin/UsersPage';
import AuditPage from '@/pages/admin/AuditPage';
import SetPassword from '@/pages/SetPassword';
import { ALL_ITEMS } from '@/nav';

function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return <div className="flex h-full items-center justify-center"><img src="/brand/icon.png" alt="" className="size-12 animate-pulse" /></div>;
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

function RequirePermission({ permission, children }) {
  const { can } = useAuth();
  if (!can(permission)) {
    return <p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">You don&apos;t have access to this page.</p>;
  }
  return children;
}

/** First screen the user can actually open. */
function Home() {
  const { can } = useAuth();
  const first = ALL_ITEMS.find((i) => can(i.permission) && !i.milestone) || ALL_ITEMS.find((i) => can(i.permission));
  return <Navigate to={first?.to || '/login'} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/set-password" element={<SetPassword />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route index element={<Home />} />
          <Route path="/dashboard" element={<RequirePermission permission="dashboard:read"><DashboardPage /></RequirePermission>} />
          <Route path="/analytics" element={<RequirePermission permission="analytics:read"><AnalyticsPage /></RequirePermission>} />
          <Route path="/users" element={<RequirePermission permission="users:read"><UsersPage /></RequirePermission>} />
          <Route path="/audit" element={<RequirePermission permission="audit:read"><AuditPage /></RequirePermission>} />
          <Route path="/ai/agent" element={<RequirePermission permission="agent:read"><AgentPage /></RequirePermission>} />
          <Route path="/ai/test" element={<RequirePermission permission="agent:write"><TestChatPage /></RequirePermission>} />
          <Route path="/ai/tools" element={<RequirePermission permission="agent:read"><ToolsPage /></RequirePermission>} />
          <Route path="/inbox" element={<RequirePermission permission="inbox:read"><InboxPage /></RequirePermission>} />
          <Route path="/inbox/:id" element={<RequirePermission permission="inbox:read"><InboxPage /></RequirePermission>} />
          <Route path="/templates" element={<RequirePermission permission="templates:read"><TemplatesPage /></RequirePermission>} />
          <Route path="/broadcasts" element={<RequirePermission permission="broadcasts:read"><BroadcastsPage /></RequirePermission>} />
          <Route path="/followups" element={<RequirePermission permission="automations:read"><FollowupsPage /></RequirePermission>} />
          <Route path="/bookings" element={<RequirePermission permission="bookings:read"><BookingsPage /></RequirePermission>} />
          <Route path="/contacts" element={<RequirePermission permission="leads:read"><LeadsPage /></RequirePermission>} />
          <Route path="/gallery" element={<RequirePermission permission="gallery:read"><GalleryPage /></RequirePermission>} />
          <Route path="/pricing" element={<RequirePermission permission="pricing:read"><PricingPage /></RequirePermission>} />
          <Route path="/settings" element={<RequirePermission permission="settings:read"><SettingsPage /></RequirePermission>} />
          {ALL_ITEMS.filter((i) => i.milestone).map((i) => (
            <Route key={i.to} path={i.to} element={<RequirePermission permission={i.permission}><ComingSoon /></RequirePermission>} />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
