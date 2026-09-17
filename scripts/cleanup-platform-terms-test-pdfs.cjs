// Limpieza única de archivos de términos usados durante las pruebas locales.
const fs = require('node:fs/promises');
const { join, resolve, sep } = require('node:path');

async function removePlatformTermsTestPdfs(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  let removed = 0;
  const pattern = /^platform-terms-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pdf$/;
  for (const entry of entries) {
    // No recorre subdirectorios, enlaces, contratos ni archivos con otro nombre.
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    try { await fs.unlink(join(directory, entry.name)); removed++; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return removed;
}

async function main() {
  const backendRoot = resolve(__dirname, '..');
  const { ConfigModule } = require('@nestjs/config');
  await ConfigModule.forRoot({ envFilePath: join(backendRoot, '.env') });
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    // Los registros de prueba se retiran primero, mediante la migración.
    const applied = await prisma.$queryRaw`
      SELECT migration_name FROM _prisma_migrations
      WHERE migration_name = '20260918030000_platform_terms_text_only'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL LIMIT 1`;
    if (!applied.length) throw new Error('Run npx prisma migrate deploy before this cleanup.');
    const directory = resolve(process.env.CONTRACT_STORAGE_DIR || join(backendRoot, 'private', 'contracts'));
    const publicRoot = join(backendRoot, 'uploads');
    if (directory === publicRoot || directory.startsWith(publicRoot + sep))
      throw new Error('CONTRACT_STORAGE_DIR must be outside the public uploads directory.');
    const removed = await removePlatformTermsTestPdfs(directory);
    console.log(`Removed ${removed} platform terms test PDF(s).`);
  } finally { await prisma.$disconnect(); }
}

module.exports = { removePlatformTermsTestPdfs };
if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
