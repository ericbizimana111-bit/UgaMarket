/**
 * Cloudinary image storage (network mocked — never calls the real API).
 * Covers signing, delivery URLs, public-id parsing, upload/destroy wiring and
 * that the image service switches to Cloudinary when configured.
 */
const crypto = require('crypto');
const env = require('../src/config/env');
const cloudinary = require('../src/services/cloudinary.service');
const imageService = require('../src/services/image.service');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const URL_BASE = 'https://res.cloudinary.com/demo-cloud/image/upload';

describe('cloudinary.service', () => {
  const original = { url: env.CLOUDINARY_URL, folder: env.CLOUDINARY_FOLDER, fetch: global.fetch };
  let calls;

  beforeEach(() => {
    env.CLOUDINARY_URL = 'cloudinary://123456:s3cr3t@demo-cloud';
    env.CLOUDINARY_FOLDER = 'ugamarket';
    calls = [];
    global.fetch = jest.fn(async (url, init) => {
      const fields = Object.fromEntries([...init.body.entries()].filter(([k]) => k !== 'file'));
      calls.push({ url, fields, hasFile: init.body.has('file') });
      const body = url.endsWith('/destroy')
        ? { result: 'ok' }
        : { secure_url: `${URL_BASE}/v1712345678/${fields.public_id || 'ugamarket/abc123'}.png`, public_id: fields.public_id || 'ugamarket/abc123' };
      return { ok: true, status: 200, json: async () => body };
    });
  });

  afterEach(() => {
    env.CLOUDINARY_URL = original.url;
    env.CLOUDINARY_FOLDER = original.folder;
    global.fetch = original.fetch;
  });

  test('parses CLOUDINARY_URL and reports enabled', () => {
    expect(cloudinary.parseCloudinaryUrl('cloudinary://k:s@cloud')).toEqual({ apiKey: 'k', apiSecret: 's', cloudName: 'cloud' });
    expect(cloudinary.parseCloudinaryUrl('nonsense')).toBeNull();
    expect(cloudinary.isEnabled()).toBe(true);
    env.CLOUDINARY_URL = '';
    expect(cloudinary.isEnabled()).toBe(false);
  });

  test('signature follows Cloudinary rules (sorted params + secret, sha1)', () => {
    const expected = crypto.createHash('sha1').update('folder=ugamarket&timestamp=1700000000' + 's3cr3t').digest('hex');
    expect(cloudinary.sign({ timestamp: 1700000000, folder: 'ugamarket', empty: '' }, 's3cr3t')).toBe(expected);
  });

  test('delivery URLs get automatic format/quality, once', () => {
    const raw = `${URL_BASE}/v1/ugamarket/a.jpg`;
    const delivered = cloudinary.toDeliveryUrl(raw);
    expect(delivered).toBe(`${URL_BASE}/f_auto,q_auto/v1/ugamarket/a.jpg`);
    expect(cloudinary.toDeliveryUrl(delivered)).toBe(delivered);
  });

  test('public id is recovered from a delivery URL (incl. folders with underscores)', () => {
    expect(cloudinary.publicIdFromUrl(`${URL_BASE}/f_auto,q_auto/v17/ugamarket/seed/tecno-spark.jpg`)).toBe('ugamarket/seed/tecno-spark');
    expect(cloudinary.publicIdFromUrl(`${URL_BASE}/v17/my_shop/x.png`)).toBe('my_shop/x');
  });

  test('upload sends a signed request with the file and returns the optimized URL', async () => {
    const url = await cloudinary.uploadImage(PNG, { filename: 'upload.png' });
    expect(url).toBe(`${URL_BASE}/f_auto,q_auto/v1712345678/ugamarket/abc123.png`);
    const [c] = calls;
    expect(c.url).toBe('https://api.cloudinary.com/v1_1/demo-cloud/image/upload');
    expect(c.hasFile).toBe(true);
    expect(c.fields).toMatchObject({ folder: 'ugamarket', api_key: '123456' });
    expect(c.fields.signature).toBe(cloudinary.sign({ folder: 'ugamarket', timestamp: c.fields.timestamp }, 's3cr3t'));
    expect(c.fields).not.toHaveProperty('api_secret');
  });

  test('seed uploads use a fixed public id and never overwrite', async () => {
    await cloudinary.uploadImage(PNG, { filename: 'x.jpg', publicId: 'seed/tecno' });
    expect(calls[0].fields).toMatchObject({ public_id: 'ugamarket/seed/tecno', overwrite: 'false' });
    expect(calls[0].fields).not.toHaveProperty('folder');
  });

  test('image service stores new uploads on Cloudinary when configured', async () => {
    const url = await imageService.saveImageFile(PNG, 'image/png');
    expect(cloudinary.isCloudinaryUrl(url)).toBe(true);
  });

  test('upload failures surface as errors (no silent broken images)', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid Signature' } }) }));
    await expect(cloudinary.uploadImage(PNG)).rejects.toThrow(/Invalid Signature/);
  });

  test('destroy targets the right public id', async () => {
    const ok = await cloudinary.destroyImage(`${URL_BASE}/f_auto,q_auto/v17/ugamarket/abc123.png`);
    expect(ok).toBe(true);
    expect(calls[0].url).toBe('https://api.cloudinary.com/v1_1/demo-cloud/image/destroy');
    expect(calls[0].fields.public_id).toBe('ugamarket/abc123');
  });
});
