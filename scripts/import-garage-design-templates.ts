import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import { readGarageDesignTemplate, type GarageDesignTemplate } from '../src/garage-designs/design-template';

class ImportValidationError extends Error {}
export type DesignTemplateImportRow = { name: string; template: GarageDesignTemplate; sortOrder: number };
type ExistingDesign = { id: number; name: string };
type ImportPlanRow = DesignTemplateImportRow & { id: number | null; action: 'create' | 'update' };

const nameKey = (name: string) => name.trim().normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase();

export function parseGarageDesignTemplateImport(value: unknown): DesignTemplateImportRow[] {
  if (!Array.isArray(value) || !value.length) throw new ImportValidationError('Input must be a nonempty JSON array.');
  const names = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.name !== 'string' ||
      !item.name.trim() || item.name.trim().length > 100) throw new ImportValidationError(`Row ${index + 1}: provide a name of 1–100 characters.`);
    const name = item.name.trim();
    if (names.has(nameKey(name))) throw new ImportValidationError(`Row ${index + 1}: duplicate design name in the input.`);
    names.add(nameKey(name));
    const template = readGarageDesignTemplate(item.template);
    if (!template) throw new ImportValidationError(`Row ${index + 1}: invalid design template.`);
    const sortOrder = item.sourceOrder ?? index;
    if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 2147483647)
      throw new ImportValidationError(`Row ${index + 1}: sourceOrder must be a nonnegative database integer.`);
    // Source-file descriptions and other import metadata are deliberately ignored.
    return { name, template, sortOrder };
  });
}

export function planGarageDesignTemplateImport(rows: DesignTemplateImportRow[], existing: ExistingDesign[]): ImportPlanRow[] {
  const claimed = new Set<number>();
  return rows.map(row => {
    const matches = existing.filter(design => nameKey(design.name) === nameKey(row.name));
    if (matches.length > 1 || (matches[0] && claimed.has(matches[0].id)))
      throw new ImportValidationError(`Ambiguous design name in the database: ${row.name}. No import was applied.`);
    const match = matches[0];
    if (match) claimed.add(match.id);
    return { ...row, id: match?.id ?? null, action: match ? 'update' : 'create' };
  });
}

export function localGarageDesignDatabaseUrl(value: string | undefined): string {
  let url: URL;
  try { url = new URL(value ?? ''); } catch { throw new ImportValidationError('A valid local DATABASE_URL is required.'); }
  if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname.length < 2)
    throw new ImportValidationError('This import only supports a MySQL database on localhost or 127.0.0.1.');
  return value!;
}

export async function runGarageDesignTemplateImport(tx: Prisma.TransactionClient, rows: DesignTemplateImportRow[], apply: boolean) {
  const existing = await tx.designPattern.findMany({ select: { id: true, name: true }, orderBy: { id: 'asc' } });
  const plan = planGarageDesignTemplateImport(rows, existing);
  const results: Array<{ id: number | null; name: string; action: string }> = [];
  const claimed = new Set<number>();
  for (const row of plan) {
    // Check database collation as well as the offline name normalization. On
    // apply this also catches an input alias of a row created earlier in this transaction.
    const matches = await tx.designPattern.findMany({ where: { name: row.name }, select: { id: true, name: true } });
    if (matches.length > 1 || (matches[0] && claimed.has(matches[0].id)) ||
      (row.id !== null && matches[0]?.id !== row.id) || (row.id === null && matches.length))
      throw new ImportValidationError(`Ambiguous or changed design name: ${row.name}. No import was applied.`);
    if (!apply) {
      results.push({ id: row.id, name: matches[0]?.name ?? row.name, action: row.action });
      if (row.id !== null) claimed.add(row.id);
      continue;
    }
    const saved = row.id === null
      ? await tx.designPattern.create({ data: { name: row.name, template: row.template, isActive: true, sortOrder: row.sortOrder, imageUrl: null }, select: { id: true, name: true } })
      : await tx.designPattern.update({ where: { id: row.id }, data: { template: row.template }, select: { id: true, name: true } });
    claimed.add(saved.id);
    results.push({ ...saved, action: row.id === null ? 'created' : 'updated' });
  }
  return { mode: apply ? 'apply' : 'dry-run', create: plan.filter(row => row.action === 'create').length,
    update: plan.filter(row => row.action === 'update').length, designs: results };
}

async function main(args: string[]) {
  const files = args.filter(arg => !arg.startsWith('--'));
  if (files.length !== 1 || args.some(arg => arg.startsWith('--') && !['--apply', '--dry-run'].includes(arg)) ||
    (args.includes('--apply') && args.includes('--dry-run')))
    throw new ImportValidationError('Usage: ts-node -r tsconfig-paths/register scripts/import-garage-design-templates.ts DATA.json [--apply|--dry-run]');
  let rows: DesignTemplateImportRow[];
  try { rows = parseGarageDesignTemplateImport(JSON.parse(readFileSync(resolve(files[0]), 'utf8'))); }
  catch (error) {
    if (error instanceof ImportValidationError) throw error;
    throw new ImportValidationError('The input file could not be read as JSON.');
  }
  let configured = process.env.DATABASE_URL;
  if (!configured) {
    try { configured = parseEnv(readFileSync(resolve(__dirname, '../.env'))).DATABASE_URL; }
    catch { throw new ImportValidationError('DATABASE_URL is missing and the local .env could not be read.'); }
  }
  const db = new PrismaClient({ datasources: { db: { url: localGarageDesignDatabaseUrl(configured) } } });
  try {
    const result = await db.$transaction(tx => runGarageDesignTemplateImport(tx, rows!, args.includes('--apply')),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 });
    console.log(JSON.stringify(result, null, 2));
  } finally { await db.$disconnect(); }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  // Never print driver errors or connection strings, which can contain credentials.
  console.error(JSON.stringify({ error: error instanceof ImportValidationError ? error.message :
    typeof error?.code === 'string' && /^P\d+$/.test(error.code) ? `Database operation failed (${error.code}).` : 'Import failed. Check the local database, migrations and input file.' }));
  process.exitCode = 1;
});
