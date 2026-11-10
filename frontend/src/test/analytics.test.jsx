import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { duration, compact, Stat, Bars } from '@/pages/analytics/charts';

describe('analytics formatting', () => {
  test('durations read naturally', () => {
    expect(duration(null)).toBe('—');
    expect(duration(45)).toBe('45s');
    expect(duration(180)).toBe('3m');
    expect(duration(190)).toBe('3m 10s');
    expect(duration(3600)).toBe('1h');
    expect(duration(5400)).toBe('1h 30m');
  });
  test('axis labels use k and lakh', () => {
    expect(compact(0, true)).toBe('₹0');
    expect(compact(2500, true)).toBe('₹2.5k');
    expect(compact(150000, true)).toBe('₹1.5L');
    expect(compact(0.25, true)).toBe('₹0.25');
    expect(compact(12)).toBe('12');
  });
});

describe('Stat', () => {
  test('lower reply time is shown as an improvement, with words not just colour', () => {
    render(<Stat label="Typical reply time" value="40s" now={40} before={80} better="down" />);
    const d = screen.getByText(/down on the previous period/).parentElement;
    expect(d.className).toMatch(/text-success/);
    expect(d.textContent).toMatch(/50%/);
  });
  test('no arrow when unchanged or no history', () => {
    const { container } = render(<Stat label="Bookings" value="3" now={3} before={3} />);
    expect(container.textContent).not.toMatch(/previous period/);
  });
});

test('Bars scale to the given max and show an empty message', () => {
  const { container, rerender } = render(<Bars max={4} rows={[{ label: 'Booked', value: 1, note: '25%' }]} />);
  expect(container.querySelector('.bg-primary').style.width).toBe('25%');
  rerender(<Bars rows={[]} empty="Nothing here" />);
  expect(screen.getByText('Nothing here')).toBeTruthy();
});
