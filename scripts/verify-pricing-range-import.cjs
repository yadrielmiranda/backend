'use strict';

// Read-only verification through the application's real range selector and
// price formula. It does not bootstrap Nest or validate manufacturing sizes.
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const fs = require('node:fs');
const Decimal = require('decimal.js');
const { PrismaClient } = require('@prisma/client');
const { connection, loadCatalog } = require('./pricing-range-catalog.cjs');
const { contains, groupKey } = require('./pricing-range-import-core.cjs');
const { EstimatePieceCalculatorService } = require('../src/estimates/calculation/estimate-piece-calculator.service');
const { computeBasePrice } = require('../src/pricing/price-formula');

function interior(range, axis) {
  const lo = range[`min${axis}In`], hi = range[`max${axis}In`];
  if (lo != null && hi != null) return new Decimal(lo).plus(hi).div(2);
  if (lo != null) return new Decimal(lo).plus(1);
  if (hi != null) return new Decimal(hi).div(2);
  return new Decimal(48);
}

(async () => {
  const [planFile, reportFile] = process.argv.slice(2);
  if (!planFile || !reportFile) throw new Error('Usage: node scripts/verify-pricing-range-import.cjs PLAN.json REPORT.json');
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const { value, target } = connection();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.host) || target.database !== 'impact') throw new Error('Verification is limited to local impact.');
  const db = new PrismaClient({ datasources: { db: { url: value } } });
  try {
    const catalog = await loadCatalog(db);
    const service = new EstimatePieceCalculatorService({}, {});
    const cache = service.createCalculationCache();
    const examples = [];
    let priceChecks = 0, boundaryChecks = 0;
    async function verify(range, rule, width, height, isBoundary) {
      const system = catalog.systems.find(s => s.id === range.idSystem);
      const selected = await service.getPricingRuleForConfig({ idBrand: system.idBrand, idProd: system.idProduct, idSyst: system.id, idCryst: rule.idCrystal, mark: 'Import verification' }, range.idConfig, width, height, range.code, db, cache);
      if (selected.range?.code !== range.code) throw new Error(`Incorrect range selected for ${groupKey(range)} ${range.code}.`);
      for (const key of ['costoA', 'costoB', 'costoC']) if (!new Decimal(selected[key].toString()).eq(rule[key])) throw new Error(`Incorrect coefficient for ${range.code}.`);
      const actual = computeBasePrice(width.div(12).mul(height.div(12)), width.div(12).plus(height.div(12)).mul(2), new Decimal(selected.costoA.toString()), new Decimal(selected.costoB.toString()), new Decimal(selected.costoC.toString()));
      const expected = width.mul(height).div(144).mul(rule.costoA).plus(width.plus(height).div(6).mul(rule.costoB)).plus(rule.costoC);
      if (actual.toFixed(2) !== expected.toFixed(2)) throw new Error(`Price mismatch for ${range.code}.`);
      if (isBoundary) boundaryChecks++; else priceChecks++;
      return actual.toFixed(2);
    }
    for (const range of plan.rangesToCreate) {
      const width = interior(range, 'Width'), height = interior(range, 'Height');
      for (const rule of range.rules) {
        const price = await verify(range, rule, width, height, false);
        if (!examples.some(e => e.group === groupKey(range))) examples.push({ group: groupKey(range), range: range.code, crystal: rule.idCrystal, width: width.toFixed(), height: height.toFixed(), basePrice: price });
      }
    }
    const tested = new Set();
    for (const range of plan.rangesToCreate) for (const axis of ['Width', 'Height']) {
      const testKey = `${groupKey(range)}:${axis}`;
      if (tested.has(testKey)) continue;
      const edge = [range[`min${axis}In`], range[`max${axis}In`]].find(v => v != null && new Decimal(v).decimalPlaces() === 4);
      if (edge == null) continue;
      tested.add(testKey);
      for (const offset of ['-0.0001', '0', '0.0001']) {
        const w = axis === 'Width' ? new Decimal(edge).plus(offset) : interior(range, 'Width');
        const h = axis === 'Height' ? new Decimal(edge).plus(offset) : interior(range, 'Height');
        const matching = plan.rangesToCreate.filter(r => groupKey(r) === groupKey(range) && r.isActive && contains(r, w, h));
        if (matching.length !== 1) throw new Error('Boundary does not select exactly one workbook range.');
        for (const rule of matching[0].rules) await verify(matching[0], rule, w, h, true);
      }
    }
    const report = { status: 'verified', target, source: plan.source, priceChecks, boundaryChecks, examples, note: 'Tests range selection and base formula only; manufacturing size policies, add-ons, tax and markups are unchanged. No manufacturer price sheet was provided for comparison.' };
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: report.status, priceChecks, boundaryChecks, report: reportFile }));
  } finally { await db.$disconnect(); }
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
