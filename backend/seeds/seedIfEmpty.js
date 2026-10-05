/**
 * First-start seeding for hosts without a shell (e.g. Render free).
 *
 * Runs the full seed ONLY when the database has no admin accounts yet, i.e.
 * on the very first deploy. Every later start skips it, so prices, stock and
 * passwords that staff changed in the console are never reset.
 *
 * Used by the start command:  prisma migrate deploy && node seeds/seedIfEmpty.js && node server.js
 */
const path = require('path');
const { spawnSync } = require('child_process');
const prisma = require('../src/config/db');

(async () => {
  let admins = 0;
  try {
    admins = await prisma.admin.count();
  } finally {
    await prisma.$disconnect();
  }
  if (admins > 0) {
    console.log('Seed skipped: database already initialised.');
    return;
  }
  console.log('Empty database: running first-time seed...');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'seed.js')], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('First-time seed failed.');
    process.exit(result.status || 1);
  }
})().catch((e) => {
  console.error('Seed check failed:', e.message);
  process.exit(1);
});
