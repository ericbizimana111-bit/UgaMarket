/**
 * Sample catalogue photos for the seeded products.
 *
 * Photos live in seeds/images (committed; see seeds/images/CREDITS.md) and are
 * copied into uploads/images so they are served by the API like any photo an
 * admin uploads (/images/...). `<slug>.jpg` is the main photo and
 * `<slug>-2.jpg`, `<slug>-3.jpg`... are extra gallery photos.
 *
 * Photos an admin has uploaded are never replaced: a product is only updated
 * when it has no photo yet or still shows a previous sample photo.
 *
 * Standalone: `node seeds/productImages.js` (safe to re-run).
 */
const fs = require('fs');
const path = require('path');

const SOURCE_DIR = path.join(__dirname, 'images');
const UPLOADS_DIR = path.resolve(__dirname, '../uploads/images');
const SEED_PREFIX = 'seed-';

const isSamplePhoto = (url) =>
  !url || url.startsWith('https://images.unsplash.com/') || url.startsWith(`/images/${SEED_PREFIX}`);

function photosFor(slug) {
  return fs
    .readdirSync(SOURCE_DIR)
    .filter((f) => f === `${slug}.jpg` || new RegExp(`^${slug}-\\d+\\.jpg$`).test(f))
    .sort((a, b) => (a === `${slug}.jpg` ? -1 : b === `${slug}.jpg` ? 1 : a.localeCompare(b, 'en', { numeric: true })));
}

function publish(file) {
  const target = path.join(UPLOADS_DIR, `${SEED_PREFIX}${file}`);
  if (!fs.existsSync(target)) fs.copyFileSync(path.join(SOURCE_DIR, file), target);
  return `/images/${SEED_PREFIX}${file}`;
}

async function seedProductImages(prisma) {
  if (!fs.existsSync(SOURCE_DIR)) return { updated: 0, skipped: 0 };
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  const products = await prisma.product.findMany({
    select: { id: true, slug: true, nameEn: true, imageUrl: true, images: { select: { imageUrl: true } } },
  });
  let updated = 0;
  let skipped = 0;
  for (const product of products) {
    const files = photosFor(product.slug);
    if (files.length === 0) continue;
    const adminPhotos = product.images.some((img) => !isSamplePhoto(img.imageUrl));
    if (!isSamplePhoto(product.imageUrl) || adminPhotos) {
      skipped++;
      continue;
    }
    const urls = files.map(publish);
    await prisma.$transaction([
      prisma.productImage.deleteMany({ where: { productId: product.id } }),
      prisma.productImage.createMany({
        data: urls.map((imageUrl, i) => ({
          productId: product.id,
          imageUrl,
          altText: product.nameEn || product.slug,
          isPrimary: i === 0,
          sortOrder: i,
        })),
      }),
      prisma.product.update({ where: { id: product.id }, data: { imageUrl: urls[0] } }),
    ]);
    updated++;
  }
  return { updated, skipped };
}

module.exports = { seedProductImages };

if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
  const prisma = require('../src/config/db');
  seedProductImages(prisma)
    .then(({ updated, skipped }) => console.log(`✅ Product photos: ${updated} updated, ${skipped} kept (admin-uploaded).`))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
