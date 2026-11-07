// Runs the catalog, pricing and estimate save/reopen flows in a new, synthetic local database.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.chdir(path.resolve(__dirname, '..'));
const configured = process.env.DATABASE_URL || require('dotenv').parse(fs.readFileSync('.env')).DATABASE_URL;
const url = new URL(configured);
assert.equal(url.protocol, 'mysql:');
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Local MySQL required');
const database = 'impact_french_design_check_' + randomUUID().replaceAll('-', '');
const mysql = process.env.MYSQL_BIN || (process.platform === 'win32'
  ? 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe' : 'mysql');
function sql(statement, inTestDatabase = true) {
  execFileSync(mysql, [
    '--protocol=tcp', '--host=127.0.0.1', '--port=' + (url.port || '3306'),
    '--user=' + decodeURIComponent(url.username), ...(inTestDatabase ? [database] : []),
  ], {
    input: statement, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) },
  });
}

// Simulate an installation that already used the configuration-level pilot.
const pilotMigration = '20261106200000_french_door_designs';
function migrateFixture() {
  const migrations = fs.readdirSync('prisma/migrations', { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert(migrations.includes(pilotMigration));
  const apply = names => sql(names.map(name => fs.readFileSync(path.join('prisma/migrations', name, 'migration.sql'), 'utf8')).join('\n'));
  apply(migrations.filter(name => name <= pilotMigration));
  sql([
    "INSERT INTO Brand (name, updatedAt) VALUES ('Legacy brand', NOW(3))",
    'SET @b = LAST_INSERT_ID()',
    "INSERT INTO Product (name, diagramFamily, updatedAt) VALUES ('Legacy French Door','FRENCH_DOOR',NOW(3))",
    'SET @p = LAST_INSERT_ID()',
    'INSERT INTO brand_product (idBrand, idProduct) VALUES (@b, @p)',
    "INSERT INTO `System` (name, idBrand, idProduct, updatedAt) VALUES ('Legacy with assignments', @b, @p, NOW(3))",
    'SET @s = LAST_INSERT_ID()',
    "INSERT INTO `System` (name, idBrand, idProduct, updatedAt) VALUES ('Legacy without assignments', @b, @p, NOW(3))",
    "INSERT INTO Config (conf,idProduct,updatedAt) VALUES ('X', @p, NOW(3))",
    'SET @c = LAST_INSERT_ID()',
    'INSERT INTO sys_conf (idSystem,idConfig) VALUES (@s,@c)',
    "INSERT INTO french_door_designs (artworkKey,code,kind,unitPrice) VALUES ('FIXTURE-ZERO','Fixture zero','SINGLE',0)",
    'INSERT INTO sys_conf_door_designs (idSystem,idConfig,idDoorDesign) VALUES (@s,@c,LAST_INSERT_ID())',
  ].join(';\n') + ';');
  apply(migrations.filter(name => name > pilotMigration));
}

async function seedFixture(db) {
  const role = await db.role.upsert({ where: { name: 'admin' }, update: {}, create: { name: 'admin' } });
  const user = await db.user.create({ data: {
    username: 'fixture', firstName: 'Fixture', lastName: 'Admin', idRole: role.id, password: 'unused',
  } });
  await db.globalParameter.upsert({ where: { key: 'SALES_TAX' }, update: {}, create: { key: 'SALES_TAX', value: 0 } });
  await db.estimateStatus.upsert({ where: { name: 'Active' }, update: {}, create: { name: 'Active' } });
  const brand = await db.brand.create({ data: { name: 'Fixture Brand' } });
  const product = await db.product.create({ data: { name: 'Fixture Door', diagramFamily: 'FRENCH_DOOR' } });
  const idBrand = brand.id, idProduct = product.id;
  await db.brandProduct.create({ data: { idBrand, idProduct } });
  const system = await db.system.create({ data: { name: 'Fixture Series', idBrand, idProduct } });
  const idSystem = system.id;
  const crystal = await db.crystal.create({ data: { glass: 'Fixture Glass' } });
  const frame = await db.frameColor.create({ data: { color: 'Fixture Frame' } });
  const tint = await db.tint.create({ data: { color: 'Fixture Tint' } });
  const coating = await db.coating.create({ data: { name: 'Fixture Coating' } });
  const privacy = await db.privacy.create({ data: { name: 'Fixture Privacy' } });
  await db.systemCrystal.create({ data: { idSystem, idCrystal: crystal.id } });
  await db.systemFrameColor.create({ data: { idSystem, idFrameColor: frame.id } });
  const garageProduct = await db.product.create({ data: { name: 'Garage', diagramFamily: 'GARAGE_DOOR' } });
  await db.brandProduct.create({ data: { idBrand, idProduct: garageProduct.id } });
  const garage = await db.system.create({ data: { name: 'Fixture Garage', idBrand, idProduct: garageProduct.id, allowDesign: true } });
  const garageConfig = await db.config.create({ data: { conf: 'X', idProduct: garageProduct.id } });
  await db.sysConf.create({ data: { idSystem: garage.id, idConfig: garageConfig.id } });
  await db.systemFrameColor.create({ data: { idSystem: garage.id, idFrameColor: frame.id } });
  const garagePattern = await db.designPattern.create({ data: { name: 'Fixture garage slats', template: { version: 1, rows: [1], columns: [1], cells: [['slat']] } } });
  const garageColor = await db.designColor.create({ data: { name: 'Fixture garage finish', hexCode: '#556677', idFrameColor: frame.id } });
  await db.systemDesignOption.create({ data: { idSystem: garage.id, idDesign: garagePattern.id, idDesignColor: garageColor.id } });
  await db.brandTint.create({ data: { idBrand, idTint: tint.id } });
  await db.brandCoating.create({ data: { idBrand, idCoating: coating.id } });
  await db.brandPrivacy.create({ data: { idBrand, idPrivacy: privacy.id } });
  const configIds = {};
  for (const conf of ['X', 'XX', 'OX', 'OXXO', 'O']) {
    const config = await db.config.create({ data: { conf, idProduct, requiresWidth: true, requiresHeight: true } });
    const idConfig = config.id;
    configIds[conf] = idConfig;
    const mixed = conf === 'OX' || conf === 'OXXO';
    await db.sysConf.create({ data: { idSystem, idConfig, dimensionMode: 'ECO_WINDOWS_DOOR',
      requiresWidth: true, requiresHeight: true, requiresDoorWidth: mixed } });
    await db.pricingRule.create({ data: { idBrand, idProduct, idSystem, idConfig, idCrystal: crystal.id, costoA: 0, costoB: 0, costoC: 100 } });
    const dimensions = [1, 120].flatMap(widthIn => [1, 120].map(heightIn => ({ widthIn, heightIn, dpPosPsf: 70, dpNegPsf: -70, screws: 8 })));
    const ruleTypes = mixed ? ['DOOR', 'SIDELITE'] : [conf === 'O' ? 'SIDELITE' : 'DOOR'];
    const rules = ruleTypes.flatMap(ruleType => dimensions.map(rule => ({ ...rule, ruleType })));
    await db.dimensionPolicy.create({ data: { idSystem, idConfig, idCrystal: crystal.id, rules: { create: rules } } });
  }
  for (const [conf, sourceDoor, sidelites] of [['OX','X',1], ['OXXO','XX',2]]) {
    const idConfig = configIds[conf];
    await db.sysConfPricingComponent.createMany({ data: [
      { idSystem, idConfig, componentType: 'DOOR', sourceConfigId: configIds[sourceDoor], quantity: 1 },
      { idSystem, idConfig, componentType: 'SIDELITE', sourceConfigId: configIds.O, quantity: sidelites },
    ] });
  }
  const pattern = await db.muntinPattern.create({ data: { name: 'Fixture grid' } });
  const fullView = await db.muntinPattern.create({ data: { name: 'Fixture Full View', inputMode: 'NONE', requiresLites: false, requiresType: false } });
  const piece = (conf, extra = {}) => ({
    mark: conf, idProd: idProduct, idBrand, idSyst: idSystem, idConf: configIds[conf], qty: 3, dealerMarkup: 0,
    idFC: frame.id, idCryst: crystal.id, idTint: tint.id, idCoat: coating.id, idPrivacy: privacy.id,
    width: conf === 'XX' ? '72' : '36', height: '80',
    ...(conf === 'OX' ? { width: '54', doorWidth: '36' } : {}),
    ...(conf === 'OXXO' ? { width: '108', doorWidth: '72' } : {}), ...extra,
  });
  return { actor: { id: user.id, role: { name: role.name } }, idSystem, configIds, pattern, fullView, piece,
    garagePiece: { idProd: garageProduct.id, idBrand, idSyst: garage.id, idConf: garageConfig.id, idFC: frame.id,
      idDesign: garagePattern.id, idDesignColor: garageColor.id } };
}

let created = false, db, app;
async function main() {
  sql('CREATE DATABASE ' + database + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', false);
  created = true;
  migrateFixture();
  url.pathname = '/' + database;
  process.env.DATABASE_URL = url.toString();
  require('ts-node/register/transpile-only');
  require('tsconfig-paths/register');
  const { PrismaService } = require('../src/prisma/prisma.service');
  const { DoorDesignsController } = require('../src/door-designs/door-designs.controller');
  const { DoorDesignsService } = require('../src/door-designs/door-designs.service');
  const { SystemsController } = require('../src/systems/systems.controller');
  const { SystemsService } = require('../src/systems/systems.service');
  const { resolvePieceDesign } = require('../src/pieces/piece-design');
  const { EstimatePieceCalculatorService } = require('../src/estimates/calculation/estimate-piece-calculator.service');
  const { EstimateDimensionValidationService } = require('../src/estimates/dimensions/estimate-dimension-validation.service');
  const { EstimateMuntinService } = require('../src/estimates/muntins/estimate-muntin.service');
  const { EstimateCustomerChargesService } = require('../src/estimates/estimate-customer-charges.service');
  const { InstallationWorkflowService } = require('../src/installation/installation-workflow.service');
  const { EstimatesService } = require('../src/estimates/estimates.service');
  const { PromotionsService } = require('../src/promotions/promotions.service');
  const { LogsService } = require('../src/logs/logs.service');
  const { RolesGuard } = require('../src/auth/guards/roles/roles.guard');
  const { ValidationPipe } = require('@nestjs/common');
  const { Reflector } = require('@nestjs/core');
  const { Test } = require('@nestjs/testing');
  const Decimal = require('decimal.js');
  db = new PrismaService();
  const { actor, idSystem, configIds, pattern, fullView, piece, garagePiece } = await seedFixture(db);
  const legacy = await db.system.findMany({ where: { name: { startsWith: 'Legacy ' } }, select: { name: true, allowDesign: true } });
  assert.equal(legacy.find(row => row.name === 'Legacy with assignments').allowDesign, true);
  assert.equal(legacy.find(row => row.name === 'Legacy without assignments').allowDesign, false);
  const module = await Test.createTestingModule({
    controllers: [DoorDesignsController, SystemsController], providers: [DoorDesignsService, SystemsService, { provide: PrismaService, useValue: db }],
  }).compile();
  app = module.createNestApplication();
  app.use((req, _res, next) => { req.user = { role: { name: req.get('test-role') } }; next(); });
  app.useGlobalGuards(new RolesGuard(module.get(Reflector)));
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.init();
  const http = require('supertest')(app.getHttpServer());
  const systemPath = '/systems/' + idSystem;
  for (const role of ['dealer', 'operator']) {
    await http.get('/door-designs').set('test-role', role).expect(403);
    await http.patch(systemPath).set('test-role', role).send({ allowDesign: true }).expect(403);
  }
  const { body: seeded } = await http.get('/door-designs').set('test-role', 'admin').expect(200);
  const single = seeded.find(row => row.artworkKey === 'SD01');
  const double = seeded.find(row => row.artworkKey === 'DD01');
  assert.equal(single.kind, 'SINGLE');
  assert.equal(double.kind, 'DOUBLE');
  assert.equal(single.unitPrice, null);
  assert.equal(double.unitPrice, null);
  const catalog = module.get(DoorDesignsService);
  const systems = module.get(SystemsService);
  const setEnabled = allowDesign => http.patch(systemPath).set('test-role', 'admin').send({ allowDesign }).expect(200);
  const selectable = async conf => (await systems.getSystemConfigOptions(idSystem, configIds[conf])).doorDesigns;
  const ids = options => options.map(row => row.id).sort((a, b) => a - b);
  const zero = seeded.find(row => row.artworkKey === 'FIXTURE-ZERO');
  const { idBrand, idProd } = piece('X');
  const { body: otherSeries } = await http.post('/systems').set('test-role', 'admin')
    .send({ name: 'Another compatible series', idBrand, idProduct: idProd, allowDesign: true }).expect(201);
  assert.equal(otherSeries.allowDesign, true);
  await systems.addConfigToSystem(otherSeries.id, configIds.X);
  assert.deepEqual(await selectable('X'), []);
  await setEnabled(true);
  assert.deepEqual(ids(await selectable('X')), [zero.id], 'Zero is a valid explicit price; unset prices are unavailable');
  assert.deepEqual(await selectable('XX'), []);
  await http.patch('/door-designs/' + single.id).set('test-role', 'admin').send({ unitPrice: '-1' }).expect(400);
  await http.patch('/door-designs/' + single.id).set('test-role', 'admin').send({ code: 'S-TEST', unitPrice: '300.00' }).expect(200);
  await catalog.edit(double.id, { code: 'D-TEST', unitPrice: '500.00' });
  await assert.rejects(catalog.edit(double.id, { code: 'S-TEST' }), /already in use/i);
  const pending = await db.frenchDoorDesign.create({ data: { artworkKey: 'FIXTURE-PENDING', code: 'Fixture unpriced', kind: 'SINGLE' } });
  for (const conf of ['X','OX']) assert.deepEqual(ids(await selectable(conf)), ids([single, zero]));
  for (const conf of ['XX','OXXO']) assert.deepEqual(ids(await selectable(conf)), [double.id]);
  assert.deepEqual(await selectable('O'), []);
  const { body: allSeries } = await http.get('/systems/with-configs').set('test-role', 'dealer').expect(200);
  const french = allSeries.find(row => row.id === idSystem);
  assert.deepEqual(ids(french.doorDesigns), ids([single, double, zero]));
  assert(french.doorDesigns.every(row => !Object.hasOwn(row, 'unitPrice')));
  const expectedKinds = { X: 'SINGLE', OX: 'SINGLE', XX: 'DOUBLE', OXXO: 'DOUBLE', O: null };
  for (const row of french.sysconfs) assert.equal(row.doorDesignKind, expectedKinds[row.config.conf]);
  const garage = allSeries.find(row => row.id === garagePiece.idSyst);
  assert.deepEqual(garage.doorDesigns, []);
  assert.equal(garage.sysconfs[0].doorDesignKind, null);
  assert.equal(garage.designOptions.length, 1);
  await http.patch('/systems/' + garage.id).set('test-role', 'admin').send({ allowDesign: false }).expect(400);
  const originalGarageDesign = await resolvePieceDesign(db, garagePiece);
  assert.equal(originalGarageDesign.designSnapshot.color.hexCode, '#556677');

  const dims = new EstimateDimensionValidationService();
  const muntins = new EstimateMuntinService();
  const calculator = new EstimatePieceCalculatorService(dims, muntins);
  const logs = new LogsService(db);
  const workflow = new InstallationWorkflowService(db, undefined, logs, calculator, muntins);
  const estimates = new EstimatesService(db, logs, undefined, dims, calculator, muntins, workflow, new EstimateCustomerChargesService(db), new PromotionsService(db));
  const calculate = dto => calculator.calculatePieceMetrics(dto, new Decimal(0), db, calculator.createCalculationCache());
  const singleBase = await calculate(piece('X'));
  const freeDesign = await calculate(piece('X', { idDoorDesign: zero.id }));
  assert.equal(freeDesign.doorDesignSnapshot.unitPrice, '0.00');
  assert.equal(freeDesign.rate.toFixed(2), singleBase.rate.toFixed(2));
  await assert.rejects(calculate(piece('X', { idDoorDesign: pending.id })), /design|price/i);
  await assert.rejects(calculate({ ...piece('X'), ...garagePiece, idDoorDesign: zero.id }), /design/i);
  const estimate = await estimates.createEmptyEstimate({ name: 'Pilot' }, actor.id);
  const base = {};
  for (const [conf, design, price] of [['X', single, 300], ['XX', double, 500], ['OX', single, 300], ['OXXO', double, 500]]) {
    const dto = piece(conf);
    base[conf] = await calculate(dto);
    const saved = await estimates.addPieceToEstimate(estimate.id, { ...dto, idDoorDesign: design.id }, actor.id);
    const row = saved.pieces.find(item => item.mark === conf);
    if (conf === 'OX') assert.equal(base[conf].rate.toNumber(), 200, 'Door + one independently priced sidelite');
    if (conf === 'OXXO') assert.equal(base[conf].rate.toNumber(), 300, 'Door + two independently priced sidelites');
    assert.equal(row.doorDesignSnapshot.artworkKey, design.artworkKey);
    assert.equal(row.rate.minus(base[conf].rate.toString()).toNumber(), price);
    assert.equal(row.customerSubtotal.minus(base[conf].customerSubtotal.toString()).toNumber(), dto.qty * price);
  }
  await assert.rejects(calculate(piece('X', { idDoorDesign: single.id, muntin: { idPattern: pattern.id } })), /cannot be combined/i);
  await assert.rejects(calculate(piece('O', { idDoorDesign: single.id })), /design/i);
  await assert.rejects(calculate(piece('XX', { idDoorDesign: single.id })), /design/i);
  const clear = await calculate(piece('X', { idDoorDesign: single.id, muntin: { idPattern: fullView.id }, doorDesignSnapshot: { unitPrice: '0.00' } }));
  assert.equal(clear.doorDesignSnapshot.unitPrice, '300.00');

  await catalog.edit(single.id, { code: 'S-NEW', unitPrice: null });
  assert.deepEqual(ids(await selectable('X')), [zero.id]);
  await assert.rejects(calculate(piece('X', { idDoorDesign: single.id })), /design|price/i);
  await catalog.edit(single.id, { unitPrice: '350.50' });
  await setEnabled(false);
  assert.deepEqual(await selectable('X'), []);
  assert.deepEqual(await selectable('OXXO'), []);
  const otherOptions = await http.get('/systems/' + otherSeries.id + '/configs/' + configIds.X + '/options').set('test-role', 'dealer').expect(200);
  assert.deepEqual(ids(otherOptions.body.doorDesigns), ids([single, zero]), 'The series switch applies only to the edited series');
  const reopened = await estimates.findOneForUser(estimate.id, actor);
  const stored = reopened.pieces.find(row => row.mark === 'X');
  assert.equal(stored.doorDesignSnapshot.code, 'S-TEST');
  assert.equal(stored.doorDesignSnapshot.unitPrice, '300.00');
  assert.equal(reopened.pieces.find(row => row.mark === 'XX').doorDesignSnapshot.unitPrice, '500.00');
  const recalculated = await estimates.recalculateEstimate(estimate.id, actor);
  assert.deepEqual(recalculated.pieces.find(row => row.mark === 'X').doorDesignSnapshot, stored.doorDesignSnapshot);
  const update = extra => estimates.updatePieceInEstimate(estimate.id, stored.id, piece('X', extra), actor.id);
  const retained = await update({ qty: 4 });
  const old = retained.pieces.find(row => row.id === stored.id);
  assert.deepEqual(old.doorDesignSnapshot, stored.doorDesignSnapshot);
  assert.equal(old.rate.toFixed(2), stored.rate.toFixed(2));
  const removed = await update({ idDoorDesign: null });
  const plain = removed.pieces.find(row => row.id === stored.id);
  assert.equal(plain.doorDesignSnapshot, null);
  assert.equal(plain.rate.toFixed(2), base.X.rate.toFixed(2));
  await assert.rejects(update({ idDoorDesign: single.id }), /design/i);
  await setEnabled(true);
  const applied = await update({ idDoorDesign: single.id });
  const current = applied.pieces.find(row => row.id === stored.id);
  assert.equal(current.doorDesignSnapshot.code, 'S-NEW');
  assert.equal(current.rate.minus(plain.rate).toFixed(2), '350.50');
  assert.deepEqual(await resolvePieceDesign(db, garagePiece), originalGarageDesign);
  console.log('PASS: pilot migration, series switch, compatible priced options, independent Garage catalog, saved estimates, historical prices, removal and reselection.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { if (app) await app.close(); if (db) await db.$disconnect(); }
  finally { if (created) sql('DROP DATABASE ' + database, false); }
});
