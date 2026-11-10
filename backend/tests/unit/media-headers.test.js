// Customer-sent files are served from our domain: nothing that can run script may render inline.
const { mediaHeaders } = require('../../src/whatsapp/media-headers');

test('photos, voice notes and videos display inline', () => {
  expect(mediaHeaders('image/jpeg', null)).toMatchObject({ 'Content-Type': 'image/jpeg', 'Content-Disposition': 'inline' });
  expect(mediaHeaders('audio/ogg; codecs=opus', null)['Content-Type']).toBe('audio/ogg');
  expect(mediaHeaders('video/mp4', 'clip.mp4')['Content-Disposition']).toMatch(/^inline; filename="clip.mp4"/);
});

test.each(['text/html', 'image/svg+xml', 'application/javascript', 'text/xml', 'application/pdf', '', null])(
  '%s is forced to download as an opaque file', (mime) => {
    const h = mediaHeaders(mime, 'x.html');
    expect(h['Content-Type']).toBe('application/octet-stream');
    expect(h['Content-Disposition']).toMatch(/^attachment;/);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });

test('every response is sandboxed and cannot run script', () => {
  const csp = mediaHeaders('image/png', null)['Content-Security-Policy'];
  expect(csp).toMatch(/sandbox/);
  expect(csp).toMatch(/default-src 'none'/);
  expect(csp).not.toMatch(/script-src/);
});

test('non-English and hostile file names are safe in the header', () => {
  const h = mediaHeaders('application/pdf', 'కొటేషన్ "final"\r\n.pdf');
  expect(h['Content-Disposition']).toBe(`attachment; filename="_______ final.pdf"; filename*=UTF-8''${encodeURIComponent('కొటేషన్ final.pdf')}`);
  expect(/^[\x20-\x7e]*$/.test(h['Content-Disposition'])).toBe(true); // only header-safe characters
  expect(mediaHeaders('application/zip', '../../etc/passwd')['Content-Disposition']).not.toMatch(/\.\.\//);
});
