// Sidebar structure (Whapter-style sections). `milestone` marks screens not built yet.
import {
  SquaresFour, Tray, AddressBook, CalendarCheck, Images, CurrencyInr, Robot, Wrench,
  ChatTeardropText, ChatsCircle, Megaphone, ClockCountdown, ChartLineUp, Users, ClipboardText, GearSix,
} from '@phosphor-icons/react';

export const NAV_SECTIONS = [
  { label: 'OVERVIEW', items: [
    { to: '/dashboard', label: 'Dashboard', icon: SquaresFour, permission: 'dashboard:read', milestone: 'M9' },
  ] },
  { label: 'CONVERSATIONS', items: [
    { to: '/inbox', label: 'Inbox', icon: Tray, permission: 'inbox:read', badge: 'needs_human' },
    { to: '/contacts', label: 'Contacts & Leads', icon: AddressBook, permission: 'contacts:read', milestone: 'M7' },
    { to: '/bookings', label: 'Bookings', icon: CalendarCheck, permission: 'bookings:read', milestone: 'M7' },
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
    { to: '/templates', label: 'Templates', icon: ChatTeardropText, permission: 'templates:read', milestone: 'M8' },
    { to: '/broadcasts', label: 'Broadcasts', icon: Megaphone, permission: 'broadcasts:read', milestone: 'M8' },
    { to: '/followups', label: 'Follow-ups', icon: ClockCountdown, permission: 'automations:read', milestone: 'M8' },
  ] },
  { label: 'INSIGHTS', items: [
    { to: '/analytics', label: 'Analytics', icon: ChartLineUp, permission: 'analytics:read', milestone: 'M9' },
  ] },
  { label: 'ADMIN', items: [
    { to: '/users', label: 'Users & Roles', icon: Users, permission: 'users:read', milestone: 'M2b' },
    { to: '/audit', label: 'Audit Log', icon: ClipboardText, permission: 'audit:read', milestone: 'M2b' },
    { to: '/settings', label: 'Settings', icon: GearSix, permission: 'settings:read' },
  ] },
];

export const ALL_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);
