// Local verification: every write is restricted to a temporary profile and rolled back.
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import Decimal from 'decimal.js';
import { InstallationCatalogService } from '../src/installation/installation-catalog.service';
import { InstallationPricingService } from '../src/installation/installation-pricing.service';

const db = new PrismaClient();
const rollback = new Error('ROLLBACK_ONLY_PROFILE_VERIFICATION');
const tempName = `Verification rollback ${randomUUID()}`;
const actor = { id: 0, role: { name: 'admin' } } as any;
const pricing = new InstallationPricingService(db as any);
const catalogSnapshot = () => db.installationService.findMany({
  orderBy: { id: 'asc' }, include: { rules: { orderBy: { id: 'asc' } } },
});
const profileSnapshot = () => db.installationPriceProfile.findMany({
  orderBy: { id: 'asc' }, include: { adjustments: { orderBy: { id: 'asc' } } },
});

function dimensionsFor(service: any, rule?: any) {
  const dims: any = { widthIn: 48, heightIn: 60, areaSqFt: 20, lengthIn: 96, panelCount: 2 };
  if (!rule) return dims;
  const lower = rule.minValue == null ? null : new Decimal(rule.minValue.toString());
  const upper = rule.maxValue == null ? null : new Decimal(rule.maxValue.toString());
  let value = lower && upper ? lower.add(upper).div(2)
    : lower ? lower.add(10) : upper ? upper.div(2) : new Decimal(24);
  if (service.ruleMetric === 'PANEL_COUNT') {
    value = lower ? lower.ceil().add(lower.isInteger() && !rule.minInclusive ? 1 : 0) : new Decimal(1);
  }
  assert(value.gt(0), 'The test must use a positive measurement.');
  assert(!lower || (rule.minInclusive ? value.gte(lower) : value.gt(lower)));
  assert(!upper || (rule.maxInclusive ? value.lte(upper) : value.lt(upper)));
  const key = ({ WIDTH: 'widthIn', HEIGHT: 'heightIn', AREA: 'areaSqFt', LENGTH: 'lengthIn', PANEL_COUNT: 'panelCount' } as any)[service.ruleMetric];
  assert(key, 'A rule must have a supported metric.');
  dims[key] = value.toNumber();
  return dims;
}

function snapshot(profile: any) {
  return {
    id: profile.id, name: profile.name,
    adjustmentPercent: new Decimal(profile.adjustmentPercent.toString()),
    minimumCharge: new Decimal(profile.minimumCharge.toString()),
    rateAdjustments: { schema: 1 as const, adjustments: profile.adjustments.map((a: any) => ({
      serviceId: a.serviceId, ruleId: a.ruleId, type: a.type, value: a.value.toString(),
      ...(a.legacyLineRounding ? { legacyLineRounding: true } : {}),
    })) },
  };
}

async function main() {
  const beforeServices = await catalogSnapshot();
  const beforeProfiles = await profileSnapshot();
  assert(beforeProfiles.some(p => p.isDefault), 'An existing default is required; do not alter defaults.');
  const base = beforeServices.find(s => s.isActive && (s.ruleMetric === 'NONE' || !s.rules.some(r => r.isActive)));
  const ranged = beforeServices.find(s => s.isActive && s.ruleMetric !== 'NONE' && s.rules.some(r => r.isActive));
  assert(base && ranged, 'Need one base service and one active ranged service.');
  const rule = ranged.rules.find(r => r.isActive)!;
  const adjustments = [
    { serviceId: base.id, ruleId: null, type: 'PERCENT' as const, value: 12.3456 },
    { serviceId: ranged.id, ruleId: null, type: 'PERCENT' as const, value: 99 },
    { serviceId: ranged.id, ruleId: rule.id, type: 'AMOUNT' as const, value: 7.8901 },
  ];
  let calculationChecks = 0;
  try {
    await db.$transaction(async tx => {
      // Reuse the production catalog's create/update logic within this rollback-only transaction.
      const adapter = new Proxy(tx, { get(target, key) {
        if (key === '$transaction') return (work: (client: any) => Promise<unknown>) => work(tx);
        return Reflect.get(target, key);
      } });
      const catalog = new InstallationCatalogService(adapter as any, { log: async () => undefined } as any);
      const created = await catalog.createProfile({
        name: tempName, minimumCharge: 400, isDefault: false, isActive: true, adjustments,
      }, actor);
      assert.equal(created.isDefault, false);
      const loaded = await catalog.findProfile(created.id);
      assert.deepEqual(loaded.adjustments.map(a => [a.serviceId, a.ruleId, a.type, a.value.toString()]),
        adjustments.slice().sort((a, b) => a.serviceId - b.serviceId || (a.ruleId ?? 0) - (b.ruleId ?? 0))
          .map(a => [a.serviceId, a.ruleId, a.type, String(a.value)]));

      const checkLine = (profile: any, service: any, selectedRule: any, type: 'PERCENT' | 'AMOUNT', value: number) => {
        const line = pricing.calculateLine({ service, profile: snapshot(profile), origin: 'USER_SELECTED',
          dimensions: dimensionsFor(service, selectedRule), occurrences: 3 });
        const providerRate = new Decimal((selectedRule?.rate ?? service.baseRate).toString());
        const expectedRate = (type === 'AMOUNT' ? providerRate.add(value) : providerRate.mul(new Decimal(1).add(new Decimal(value).div(100))))
          .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
        assert.equal(line.ruleId, selectedRule?.id ?? null);
        assert.equal(line.rate.toFixed(4), providerRate.toFixed(4));
        assert.equal(line.saleRate.toFixed(4), expectedRate.toFixed(4));
        const quantity = new Decimal((line.timeSnapshot as any).quantity);
        assert.equal(line.baseAmount.toFixed(2), providerRate.mul(quantity).mul(3).toFixed(2));
        assert.equal(line.adjustedAmount.toFixed(2), expectedRate.mul(quantity).mul(3).toFixed(2));
        calculationChecks++;
      };
      checkLine(loaded, base, null, 'PERCENT', 12.3456);
      checkLine(loaded, ranged, rule, 'AMOUNT', 7.8901);
      const updated = await catalog.updateProfile(created.id, { adjustments: [
        { ...adjustments[0], type: 'AMOUNT', value: 4.3210 },
        adjustments[1],
        { ...adjustments[2], type: 'PERCENT', value: 15.4321 },
      ] }, actor);
      const reloaded = await catalog.findProfile(updated.id);
      checkLine(reloaded, base, null, 'AMOUNT', 4.3210);
      checkLine(reloaded, ranged, rule, 'PERCENT', 15.4321);
      await catalog.updateProfile(created.id, { adjustments: [{ ...adjustments[0], value: 0 }] }, actor);
      const zero = await catalog.findProfile(created.id);
      assert.equal(zero.adjustments.length, 1);
      assert.equal(zero.adjustments[0].value.toString(), '0');
      checkLine(zero, base, null, 'PERCENT', 0);
      // No rule entry means provider rate, even though the same profile contains another adjustment.
      checkLine(zero, ranged, rule, 'AMOUNT', 0);
      await catalog.updateProfile(created.id, { adjustments: [] }, actor);
      assert.equal((await catalog.findProfile(created.id)).adjustments.length, 0);
      assert.equal(JSON.stringify(await tx.installationService.findMany({
        orderBy: { id: 'asc' }, include: { rules: { orderBy: { id: 'asc' } } },
      })), JSON.stringify(beforeServices), 'Provider services and rules must never be modified.');
      // Success also MUST throw, so this test can never commit its temporary profile.
      throw rollback;
    }, { timeout: 20000 });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  assert.equal(JSON.stringify(await catalogSnapshot()), JSON.stringify(beforeServices));
  assert.equal(JSON.stringify(await profileSnapshot()), JSON.stringify(beforeProfiles));
  assert.equal(await db.installationPriceProfile.count({ where: { name: tempName } }), 0);
  console.log(JSON.stringify({ result: 'PASS', persistedAndReloaded: true, calculationChecks,
    transactionRolledBack: true, existingProfilesUnchanged: true, providerServicesAndRulesUnchanged: true }));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
