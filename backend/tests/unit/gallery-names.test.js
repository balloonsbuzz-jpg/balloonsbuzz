// Name parsing against every real naming variant seen in the client's Drive folder.
const { parsePrice, nameQuality, cleanTitle, analysePath, classify, buildContext } = require('../../src/gallery/names');

describe('parsePrice', () => {
  test.each([
    ['8k', 8000, 8000],
    ['7.5k', 7500, 7500],
    ['(10k-12k)', 10000, 12000],
    ['baby shower (5-7k)', 5000, 7000],
    ['baby shower (6.5k-8.5)', 6500, 8500],
    ['14k-15k', 14000, 15000],
    ['Peppa Pig(18k-20k', 18000, 20000],
    ['5k - 6k', 5000, 6000],
    ['5k -6k (2)', 5000, 6000],
    ['Mixed Theme (13k-15k))', 13000, 15000],
    ['Micky - Minnie13k-15k', 13000, 15000],
    ['Cars & Transport 8.5k', 8500, 8500],
    ['angry birds (5.5-6k)', 5500, 6000],
    ['BASIC (3.5-5k)', 3500, 5000],
    ['more then 3 frames (18k-35k)', 18000, 35000],
    ['Paw Patrol-(12k-15k)', 12000, 15000],
    ['k pop (7.5k-8k)', 7500, 8000],
  ])('%s -> %i-%i', (text, min, max) => {
    expect(parsePrice(text)).toMatchObject({ min, max });
  });

  test.each([
    'WhatsApp Image 2026-09-29 at 3.18.14 PM',
    'IMG-20260603-WA0015',
    'Happy Birthday (18) (2)',
    'Mermaid (1)-3',
    'Bunches( 40per bunch)',
    '50 birthday',
    '940044b36750810225e7ba0282aab9fe',
    'd6184d92-9f86-4a81-93e5-377c37857402',
    '1 11 2024 MIYAPUR',
  ])('no price in %s', (text) => {
    expect(parsePrice(text)).toBeNull();
  });
});

describe('nameQuality', () => {
  test.each([
    ['Dinosaur Theme (10k-12k).jpeg', 'proper'],
    ['Instant Decors (3).jpg', 'proper'],
    ['Baby Shower (7k-8k).jpg', 'proper'],
    ['birbe (5.5k-6k).jpg', 'proper'],
    ['8k.jpg', 'price_only'],
    ['5k -6k (2).jpeg', 'price_only'],
    ['14k-15k.png', 'price_only'],
    ['91a76e65cbf06db52d7dc50d8ebbc7c1.jpg', 'generic'],
    ['09f5cbc3-23d3-455d-9fc5-6ae25e7dddbb.jpeg', 'generic'],
    ['WhatsApp Image 2026-10-13 at 3.45.45 PM (1).jpeg', 'generic'],
    ['IMG-20260628-WA0011 - Copy.jpg', 'generic'],
    ['71IC2lqIgdL._AC_UF1000,1000_QL80_.jpg', 'generic'],
    ['saini-event-decoration-patna-balloon-decorators-xyz.webp', 'generic'],
    ['MISHIKA 2 ND EVENT 29 10 2024.jpg', 'generic'],
    ['12345.jpg', 'generic'],
  ])('%s is %s', (name, quality) => {
    expect(nameQuality(name)).toBe(quality);
  });
});

describe('cleanTitle', () => {
  test.each([
    ['Dinosaur Theme (10k-12k).jpeg', 'Dinosaur Theme'],
    ['birbe (5.5k-6k).jpg', 'Barbie'],
    ['cardle ceremeony (8k-10k) (2).jpeg', 'Cradle Ceremony'],
    ['Mixed Theme (13k-15k)).jpg', 'Mixed Theme'],
    ['Clouds - Copy.jpeg', 'Clouds'],
    ['Happy Birthday (18) (2).jpeg', 'Happy Birthday'],
    ['Mermaid (1)-3.jpg', 'Mermaid'],
    ['tom &jerry (15k-18k).jpg', 'Tom & Jerry'],
    ['Hello Kitty Thee.jpg', 'Hello Kitty Theme'],
    ['Fairy land or Fairy Tale (1).jpg', 'Fairy Land or Fairy Tale'],
    ['HBD (2).jpeg', 'HBD'],
  ])('%s -> %s', (name, title) => {
    expect(cleanTitle(name)).toBe(title);
  });
});

describe('analysePath', () => {
  test('file price beats folder price', () => {
    const a = analysePath('RING frame/foot ball/ring (5.5k-7k)/foot ball(7.5k-9k).jpg');
    expect(a).toMatchObject({ priceSource: 'filename', price: { min: 7500, max: 9000 }, style: 'ring', quality: 'proper' });
  });
  test('nearest folder price when the file has none', () => {
    const a = analysePath('ring baby shower/simple ring (6k-8k)/Baby Shower (4).jpeg');
    expect(a).toMatchObject({ priceSource: 'folder', price: { min: 6000, max: 8000 }, style: 'simple_ring', title: 'Baby Shower' });
  });
  test('no price anywhere', () => {
    expect(analysePath('sequence sheet/Happy Birthday (3).jpeg')).toMatchObject({ priceSource: 'none', price: null });
  });
  test('non-images are flagged', () => {
    expect(analysePath('BASIC (3.5-5k)/notes.txt').isImage).toBe(false);
  });
});

describe('classify', () => {
  const ctx = buildContext({
    packages: [
      { id: 'p-2f', key: 'two_frames', name: '2 Frames Decor', folder_names: ['2 frames decor'] },
      { id: 'p-ring', key: 'ring_frame', name: 'Ring Frame', folder_names: ['RING frame', 'ring baby shower', 'baby shower/ring frame(5.5k-7k)'] },
      { id: 'p-wall', key: 'wall_decor', name: 'Wall Decor', folder_names: ['baby shower/wall (4k-4.5k)'] },
      { id: 'p-trunk', key: 'car_trunk', name: 'Car Trunk', folder_names: ['car trunk decor(2.5k-3.5k)'] },
    ],
    themes: [{ id: 't-dino', key: 'dinosaur', name: 'Dinosaur' }, { id: 't-cars', key: 'cars', name: 'Cars & Racing' }, { id: 't-boss', key: 'boss_baby', name: 'Boss Baby' }],
    themeAliases: [
      { alias: 'dinosour', theme_id: 't-dino', key: 'dinosaur', name: 'Dinosaur' },
      { alias: 'car', theme_id: 't-cars', key: 'cars', name: 'Cars & Racing' },
      { alias: 'boss baby', theme_id: 't-boss', key: 'boss_baby', name: 'Boss Baby' },
    ],
    occasions: [
      { id: 'o-bday', key: 'birthday', name: 'Birthday', aliases: ['bday'] },
      { id: 'o-bs', key: 'baby_shower', name: 'Baby Shower', aliases: ['babyshower'] },
      { id: 'o-ann', key: 'anniversary', name: 'Anniversary', aliases: [] },
    ],
  });

  test('typo folder resolves to the canonical theme; category default occasion', () => {
    const c = classify('2 frames decor/dinosour/Dinosaur Theme (10k-12k).jpeg', ctx);
    expect(c.package.key).toBe('two_frames');
    expect(c.theme.key).toBe('dinosaur');
    expect(c.occasion.key).toBe('birthday');
    expect(c.price).toEqual({ min: 10000, max: 12000 });
  });
  test('price-only file takes its title from the theme folder', () => {
    const c = classify('2 frames decor/boss baby/8k.jpg', ctx);
    expect(c).toMatchObject({ quality: 'price_only', title: 'Boss Baby', price: { min: 8000, max: 8000 } });
  });
  test('two-level folder mapping and occasion from folder', () => {
    const c = classify('baby shower/wall (4k-4.5k)/x Baby decor.jpg', ctx);
    expect(c.package.key).toBe('wall_decor');
    expect(c.occasion.key).toBe('baby_shower');
  });
  test('the design category folder is never read as a theme', () => {
    const c = classify('car trunk decor(2.5k-3.5k)/Surprise Trunk.jpg', ctx);
    expect(c.theme).toBeNull();
    expect(c.price).toEqual({ min: 2500, max: 3500 });
  });
  test('occasion typo in a folder', () => {
    const c = classify('RING frame/anniversery/Anniversary (6k-7k).jpg', ctx);
    expect(c.occasion.key).toBe('anniversary');
  });
});
