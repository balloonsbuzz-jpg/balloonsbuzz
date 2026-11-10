import { expect, test } from 'vitest';
import { diff } from '@/pages/admin/AuditPage';
import { NAV_SECTIONS } from '@/nav';

test('audit diff lists only fields that changed, including added and removed ones', () => {
  expect(diff({ name: 'A', role_key: 'agent', phone: null }, { name: 'A', role_key: 'admin', is_active: false }))
    .toEqual([['role_key', 'agent', 'admin'], ['phone', null, undefined], ['is_active', undefined, false]]);
  expect(diff(null, { kind: 'daily' })).toEqual([['kind', undefined, 'daily']]);
  expect(diff({ list: [1, 2] }, { list: [1, 2] })).toEqual([]);
});

test('every screen is built: nothing in the menu is marked "soon"', () => {
  expect(NAV_SECTIONS.flatMap((s) => s.items).filter((i) => i.milestone)).toEqual([]);
});
