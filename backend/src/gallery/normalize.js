// Any photo the client drops in Drive (jpg, jfif, png, webp, avif, heic, 8 MB…)
// becomes a WhatsApp-friendly JPEG: EXIF-rotated, longest side ≤ 1600 px, under 1 MB,
// plus a 480 px thumbnail for the dashboard grid.
const sharp = require('sharp');

const MAX_SIDE = 1600;
const TARGET_BYTES = 1024 * 1024;
const THUMB_SIDE = 480;

sharp.cache(false);          // the importer streams hundreds of files; don't hold them in memory
sharp.concurrency(2);

async function encode(input, side, quality) {
  return sharp(input, { failOn: 'error', limitInputPixels: 80_000_000 })
    .rotate()
    .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality, progressive: true, chromaSubsampling: '4:2:0' })
    .toBuffer({ resolveWithObject: true });
}

/**
 * @param {Buffer} buffer original bytes
 * @returns {Promise<{image:{buffer,width,height,size}, thumb:{buffer,width,height,size}, original:{format,width,height,size}}>}
 */
async function normalizeImage(buffer) {
  const meta = await sharp(buffer, { failOn: 'error' }).metadata();
  if (!meta.format) throw new Error('not an image');

  let out = null;
  for (const [side, q] of [[MAX_SIDE, 82], [MAX_SIDE, 72], [1280, 70], [1024, 65]]) {
    out = await encode(buffer, side, q);
    if (out.data.length <= TARGET_BYTES) break;
  }
  const thumb = await encode(buffer, THUMB_SIDE, 70);
  return {
    image: { buffer: out.data, width: out.info.width, height: out.info.height, size: out.data.length },
    thumb: { buffer: thumb.data, width: thumb.info.width, height: thumb.info.height, size: thumb.data.length },
    original: { format: meta.format, width: meta.width, height: meta.height, size: buffer.length },
  };
}

const MIME_BY_FORMAT = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', heif: 'image/heif', gif: 'image/gif', tiff: 'image/tiff' };

module.exports = { normalizeImage, MIME_BY_FORMAT };
