'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

function connection() {
  let value = process.env.DATABASE_URL;
  if (!value) {
    const text = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
    const match = text.match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
    if (!match) throw new Error('DATABASE_URL is missing.');
    value = match[1].trim();
    value = /^["']/.test(value) ? value.slice(1, value.lastIndexOf(value[0])) : value.split(/\s+#/)[0];
  }
  const url = new URL(value);
  if (url.protocol !== 'mysql:') throw new Error('Expected a MySQL database.');
  return { value, target: { host: url.hostname, port: url.port || '3306', database: decodeURIComponent(url.pathname.slice(1)) } };
}

async function loadCatalog(db) {
  const [brands, products, systems, configs, crystals, sysConfs, systemCrystals, directRules, ranges, dimensionPrecision] = await Promise.all([
    db.brand.findMany({ select: { id: true, name: true, isActive: true }, orderBy: { id: 'asc' } }),
    db.product.findMany({ select: { id: true, name: true, isActive: true, kind: true, pricingMode: true, diagramFamily: true }, orderBy: { id: 'asc' } }),
    db.system.findMany({ select: { id: true, name: true, isActive: true, idBrand: true, idProduct: true }, orderBy: { id: 'asc' } }),
    db.config.findMany({ select: { id: true, conf: true, idProduct: true, isActive: true }, orderBy: { id: 'asc' } }),
    db.crystal.findMany({ select: { id: true, glass: true, isActive: true }, orderBy: { id: 'asc' } }),
    db.sysConf.findMany({ include: { pricingComponents: true, usedAsPricingSource: true }, orderBy: [{ idSystem: 'asc' }, { idConfig: 'asc' }] }),
    db.systemCrystal.findMany({ orderBy: [{ idSystem: 'asc' }, { idCrystal: 'asc' }] }),
    db.pricingRule.findMany({ orderBy: { id: 'asc' } }),
    db.pricingRange.findMany({ include: { rules: { orderBy: { idCrystal: 'asc' } } }, orderBy: { id: 'asc' } }),
    db.$queryRaw`SELECT COLUMN_NAME AS columnName, NUMERIC_PRECISION AS precisionDigits, NUMERIC_SCALE AS scaleDigits FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pricing_ranges' AND COLUMN_NAME IN ('minWidthIn','maxWidthIn','minHeightIn','maxHeightIn') ORDER BY COLUMN_NAME`,
  ]);
  return JSON.parse(JSON.stringify({ brands, products, systems, configs, crystals, sysConfs, systemCrystals, directRules, ranges, dimensionPrecision }, (_, value) => typeof value === 'bigint' ? Number(value) : value));
}

module.exports = { connection, loadCatalog };

if (require.main === module) {
  (async () => {
    const output = process.argv[2];
    if (!output) throw new Error('Usage: node scripts/pricing-range-catalog.cjs OUTPUT.json');
    const { value, target } = connection();
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.host) || target.database !== 'impact') throw new Error('This snapshot command only reads the local impact database.');
    const db = new PrismaClient({ datasources: { db: { url: value } } });
    try {
      const catalog = await db.$transaction(tx => loadCatalog(tx), { isolationLevel: 'RepeatableRead', timeout: 60000 });
      fs.writeFileSync(output, JSON.stringify({ target, catalog }, null, 2) + '\n', { flag: 'wx' });
      console.log(JSON.stringify({ target, systems: catalog.systems.length, directRules: catalog.directRules.length, ranges: catalog.ranges.length, output }));
    } finally {
      await db.$disconnect();
    }
  })().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
}
