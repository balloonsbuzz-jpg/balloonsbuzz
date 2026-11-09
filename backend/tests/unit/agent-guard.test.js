const { extractAmounts, checkPrices, amountsInResult, splitMessage, stripInternal } = require('../../src/agent/guard');

describe('stripInternal', () => {
  test('removes history notation and ids the model echoes (seen in the live eval)', () => {
    const echoed = '[Photo sent: Spiderman · 2 Frames Decor · ₹10,000 – ₹12,000 (estimate) (photo_id 3201b3c8-d41a-4fbb-8d3a-1b64fe7bc519)] [Photo sent: Spiderman (photo_id ff7f04db-f936-41ff-8c78-0735873a6ead)]';
    expect(stripInternal(echoed)).toBe('');
    expect(stripInternal('Lovely! (photo_id 3201b3c8-d41a-4fbb-8d3a-1b64fe7bc519) Which date?')).toBe('Lovely! Which date?');
    expect(stripInternal('Hi there 🎈\n\nWhat is the occasion?')).toBe('Hi there 🎈\n\nWhat is the occasion?');
  });
});

describe('extractAmounts', () => {
  test.each([
    ['The 2-frame dinosaur setup is ₹12,000', [12000]],
    ['Rs. 9500 only', [9500]],
    ['INR 10,500 including travel', [10500]],
    ['Range is ₹10,000 – ₹12,000', [10000, 12000]],
    ['₹10,000 – 12,000 depending on size', [10000, 12000]],
    ['around ₹10-12k', [10000, 12000]],
    ['It costs 8k', [8000]],
    ['between 10-12k', [10000, 12000]],
    ['7,500 rupees', [7500]],
    ['Final price 11,700/-', [11700]],
    ['₹1.2 lakh wedding stage', [120000]],
    ['Travel charge is ₹300 and bunches are ₹40 each', [300, 40]],
    ['₹6.5k', [6500]],
  ])('%s', (text, amounts) => {
    expect(extractAmounts(text).sort((a, b) => a - b)).toEqual([...amounts].sort((a, b) => a - b));
  });

  test.each([
    'Your event is on 12/12/2026 at 5 pm',
    'Venue is 7.2 km from Miyapur',
    'We can fit 50 guests and 3 frames',
    'Call us on 9392534625',
    'Give us 2 days and 30% advance',
    'Booking code BB-2026-0042',
  ])('no amounts in "%s"', (text) => {
    expect(extractAmounts(text)).toEqual([]);
  });
});

describe('checkPrices', () => {
  const allowed = new Set([12000, 10000, 300, 11400]);
  test('issued amounts pass', () => {
    expect(checkPrices('It is ₹12,000 plus ₹300 travel. Best I can do is ₹11,400 😊', allowed)).toEqual({ ok: true, unknown: [] });
  });
  test('an invented price is blocked', () => {
    expect(checkPrices('Okay, ₹9,000 final!', allowed)).toEqual({ ok: false, unknown: [9000] });
    expect(checkPrices('We can do 9k', allowed)).toEqual({ ok: false, unknown: [9000] });
  });
  test('text without prices passes', () => {
    expect(checkPrices('Which date is the party? 🎈', allowed).ok).toBe(true);
  });
});

describe('amountsInResult', () => {
  test('collects money fields and amounts inside captions, ignores counts and km', () => {
    const r = { quote_id: 'x', full_price: 12300, design_price_range: [10000, 12000], distance: { km: 7.2, charge: 300 },
      photos: [{ caption: 'Dinosaur Theme\n₹10,000 – ₹12,000 (estimate)' }], count: 3, rounds_left: 2 };
    expect([...amountsInResult(r)].sort((a, b) => a - b)).toEqual([300, 10000, 12000, 12300]);
  });
});

describe('splitMessage', () => {
  test('short text stays one message', () => {
    expect(splitMessage('Hi! 🎈 What is the occasion?')).toEqual(['Hi! 🎈 What is the occasion?']);
  });
  test('every part is at most 300 characters and nothing is lost', () => {
    const long = `${'We decorate birthdays, baby showers and anniversaries across Hyderabad. '.repeat(5)}\n\n${'Every design can be customised with names, colours and themes you like. '.repeat(4)}`;
    const parts = splitMessage(long, 300);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(300);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' ').trim());
  });
  test('a single very long word is hard-cut', () => {
    const parts = splitMessage('x'.repeat(650), 300);
    expect(parts.map((p) => p.length)).toEqual([300, 300, 50]);
  });
  test('respects a custom limit', () => {
    for (const p of splitMessage('One. Two two. Three three three. Four four four four.', 20)) expect(p.length).toBeLessThanOrEqual(20);
  });
});
