// Sidebar structure (Whapter-style sections). `milestone` marks screens not built yet.
import {
  SquaresFour, Tray, AddressBook, CalendarCheck, Images, CurrencyInr, Robot, Wrench,
  ChatTeardropText, ChatsCircle, Megaphone, ClockCountdown, ChartLineUp, Users, ClipboardText, GearSix,
} from '@phosphor-icons/react';

export const NAV_SECTIONS = [
  { label: 'OVERVIEW', items: [
    { to: '/dashboard', label: 'Dashboard', icon: SquaresFour, permission: 'dashboard:read' },
  ] },
  { label: 'CONVERSATIONS', items: [
    { to: '/inbox', label: 'Inbox', icon: Tray, permission: 'inbox:read', badge: 'needs_human' },
    { to: '/contacts', label: 'Contacts & Leads', icon: AddressBook, permission: 'leads:read' },
    { to: '/bookings', label: 'Bookings', icon: CalendarCheck, permission: 'bookings:read' },
  ] },
  { label: 'CATALOGUE', items: [
    { to: '/gallery', label: 'Gallery', icon: Images, permission: 'gallery:read' },
    { to: '/pricing', label: 'Pricing & Rules', icon: CurrencyInr, permission: 'pricing:read' },
  ] },
  { label: 'AI', items: [
    { to: '/ai/agent', label: 'AI Agent', icon: Robot, permission: 'agent:read' },
    { to: '/ai/tools', label: 'Tools', icon: Wrench, permission: 'agent:read' },
    { to: '/ai/test', label: 'Test chat', icon: ChatsCircle, permission: 'agent:write' },
  ] },
  { label: 'MARKETING', items: [
    { to: '/templates', label: 'Templates', icon: ChatTeardropText, permission: 'templates:read' },
    { to: '/broadcasts', label: 'Broadcasts', icon: Megaphone, permission: 'broadcasts:read' },
    { to: '/followups', label: 'Follow-ups', icon: ClockCountdown, permission: 'automations:read' },
  ] },
  { label: 'INSIGHTS', items: [
    { to: '/analytics', label: 'Analytics', icon: ChartLineUp, permission: 'analytics:read' },
  ] },
  { label: 'ADMIN', items: [
    { to: '/users', label: 'Users & Roles', icon: Users, permission: 'users:read' },
    { to: '/audit', label: 'Audit Log', icon: ClipboardText, permission: 'audit:read' },
    { to: '/settings', label: 'Settings', icon: GearSix, permission: 'settings:read' },
  ] },
];

export const ALL_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);
