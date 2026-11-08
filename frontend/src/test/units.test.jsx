import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { diffLines } from '@/lib/diff';
import { errorMessage } from '@/lib/api';
import { ChipsInput } from '@/pages/ai/fields';
import { NAV_SECTIONS } from '@/nav';

describe('diffLines', () => {
  test('marks added, removed and unchanged lines in order', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
      { type: 'same', text: 'a' }, { type: 'removed', text: 'b' }, { type: 'added', text: 'x' }, { type: 'same', text: 'c' },
    ]);
  });
  test('identical text has no changes', () => {
    expect(diffLines('one\ntwo', 'one\ntwo').every((l) => l.type === 'same')).toBe(true);
  });
});

describe('errorMessage', () => {
  test('lists field errors from the API', () => {
    const err = { response: { data: { error: 'Invalid input', details: [{ field: 'temperature', message: 'Too big' }] } } };
    expect(errorMessage(err)).toBe('temperature: Too big');
  });
  test('falls back to the API error text', () => {
    expect(errorMessage({ response: { data: { error: 'Nope' } } })).toBe('Nope');
  });
});

describe('ChipsInput', () => {
  test('adds lower-cased chips on Enter, ignores duplicates, removes with ×', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ChipsInput id="k" value={['human']} onChange={onChange} />);
    await userEvent.type(screen.getByRole('textbox'), 'Call Me{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['human', 'call me']);
    onChange.mockClear();
    await userEvent.type(screen.getByRole('textbox'), 'HUMAN{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    rerender(<ChipsInput id="k" value={['human', 'call me']} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText('Remove human'));
    expect(onChange).toHaveBeenLastCalledWith(['call me']);
  });
});

describe('navigation', () => {
  test('every item has a permission and unique route', () => {
    const items = NAV_SECTIONS.flatMap((s) => s.items);
    expect(items.every((i) => i.permission && i.to.startsWith('/'))).toBe(true);
    expect(new Set(items.map((i) => i.to)).size).toBe(items.length);
  });
});
