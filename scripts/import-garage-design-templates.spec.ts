// Run directly with ts-node/register; this offline check never connects to MySQL.
import * as assert from 'node:assert/strict';
import { parseGarageDesignTemplateImport, planGarageDesignTemplateImport, runGarageDesignTemplateImport, localGarageDesignDatabaseUrl } from './import-garage-design-templates';

const template = { version: 1, columns: [1], rows: [1], cells: [['slat']] };

async function main() {
  const rows = parseGarageDesignTemplateImport([{ name: ' Existing ', template, sourceFile: 'ignored.svg' }, { name: 'New', template, sourceOrder: 12 }]);
  assert.equal(rows[0].name, 'Existing');
  assert.equal(rows[1].sortOrder, 12);
  assert.equal('sourceFile' in rows[0], false);
  assert.throws(() => parseGarageDesignTemplateImport([{ name: 'Duplicate', template }, { name: ' duplicate ', template }]), /duplicate/);
  assert.throws(() => parseGarageDesignTemplateImport([{ name: 'Bad', template: { ...template, cells: [['svg']] } }]), /invalid/);
  assert.throws(() => planGarageDesignTemplateImport(rows, [{ id: 1, name: 'Existing' }, { id: 2, name: 'existing' }]), /Ambiguous/);
  assert.throws(() => localGarageDesignDatabaseUrl('mysql://private:secret@prod.example/database'), /localhost/);
  assert.throws(() => localGarageDesignDatabaseUrl('not-a-url'), /local DATABASE_URL/);
  assert.equal(localGarageDesignDatabaseUrl('mysql://user:password@127.0.0.1/catalog'), 'mysql://user:password@127.0.0.1/catalog');

  const catalog: any[] = [{ id: 1, name: 'Existing', isActive: false, imageUrl: '/keep.png', sortOrder: 22 }, { id: 2, name: 'Untouched' }];
  const writes: any[] = [];
  const tx = { designPattern: {
    findMany: async (args: any) => catalog.filter(row => !args.where || row.name.toUpperCase() === args.where.name.toUpperCase()).map(({ id, name }) => ({ id, name })),
    create: async ({ data }: any) => { writes.push({ create: data }); const row = { ...data, id: 3 }; catalog.push(row); return { id: row.id, name: row.name }; },
    update: async ({ where, data }: any) => { writes.push({ update: data }); const row = catalog.find(row => row.id === where.id); Object.assign(row, data); return { id: row.id, name: row.name }; },
  } };
  const dry = await runGarageDesignTemplateImport(tx as any, rows, false);
  assert.equal(dry.mode, 'dry-run');
  assert.equal(writes.length, 0);
  assert.deepEqual(dry.designs.map(row => row.action), ['update', 'create']);
  const applied = await runGarageDesignTemplateImport(tx as any, rows, true);
  assert.deepEqual(applied.designs.map(row => row.action), ['updated', 'created']);
  assert.deepEqual(writes[0], { update: { template } });
  assert.deepEqual(writes[1], { create: { name: 'New', template, isActive: true, sortOrder: 12, imageUrl: null } });
  assert.equal(catalog[0].isActive, false);
  assert.equal(catalog[0].imageUrl, '/keep.png');
  assert.equal(catalog[0].sortOrder, 22);
  assert.deepEqual(catalog[1], { id: 2, name: 'Untouched' });
  console.log('Garage design import offline validation passed. No database connection was opened.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
