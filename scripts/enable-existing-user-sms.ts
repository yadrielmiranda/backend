import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { Prisma, PrismaClient, SmsConsent, SmsConsentEvent } from '@prisma/client';
import { buildSmsProgram } from '../src/sms/sms-program';
import { supportsSmsPhone } from '../src/sms/sms-phone-support';

const usage = 'node -r ts-node/register scripts/enable-existing-user-sms.ts --admin USERNAME [--apply|--dry-run]';
class ActivationError extends Error {}
type Options = { adminUsername: string; apply: boolean };
type Action = 'ENABLE' | 'ALREADY_ENABLED' | 'PREVIOUS_OPT_OUT' | 'INACTIVE' |
  'UNSUPPORTED_PHONE' | 'PHONE_CHANGED' | 'STOP' | 'MISSING_USER';
type ResultRow = { id: number; username: string; service: Action; promotional: Action };
type History = Array<Pick<SmsConsentEvent, 'action' | 'category'>>;

export function parseSmsActivationArgs(args: string[]): Options {
  let adminUsername: string | undefined;
  let mode: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--admin' && !adminUsername && args[i + 1] && !args[i + 1].startsWith('--')) {
      adminUsername = args[++i].trim();
    } else if (['--apply', '--dry-run'].includes(args[i]) && !mode) {
      mode = args[i];
    } else throw new ActivationError(`Usage: ${usage}`);
  }
  if (!adminUsername) throw new ActivationError(`Provide the administrator username. Usage: ${usage}`);
  return { adminUsername, apply: mode === '--apply' };
}

function categoryAction(previous: SmsConsent | null, history: History, category: 'SERVICE' | 'PROMOTIONAL'): Action {
  const service = category === 'SERVICE';
  const enabled = service ? previous?.enabled : previous?.promotionsEnabled;
  const date = service ? previous?.consentedAt : previous?.promotionsConsentedAt;
  const version = service ? previous?.consentVersion : previous?.promotionsConsentVersion;
  const text = service ? previous?.consentText : previous?.promotionsConsentText;
  const revoked = service ? previous?.revokedAt : previous?.promotionsRevokedAt;
  // Preserve an existing valid subscription, including its original evidence/date.
  if (enabled && date && version && text && !revoked) return 'ALREADY_ENABLED';
  const priorRevocation = history.some(event =>
    ['OPT_OUT', 'PROVIDER_STOP', 'PHONE_CHANGED', 'ACCOUNT_DISABLED'].includes(event.action) &&
    (event.category == null || event.category === 'ALL' || event.category === category),
  );
  return revoked || priorRevocation ? 'PREVIOUS_OPT_OUT' : 'ENABLE';
}

export async function runExistingUserSmsActivation(
  db: PrismaClient,
  options: Options,
  now = new Date(),
) {
  // Only accounts present when this invocation starts; no ongoing/default opt-in.
  const candidates = await db.user.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  return db.$transaction(async tx => {
    let admin = await tx.user.findUnique({ where: { username: options.adminUsername }, include: { role: true } });
    if (options.apply && admin) {
      const ids = [...new Set([...candidates.map(user => user.id), admin.id])].sort((a, b) => a - b);
      // Profile edits, phone changes and STOP handlers lock these same User rows.
      await tx.$queryRaw`SELECT id FROM User WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
      admin = await tx.user.findUnique({ where: { username: options.adminUsername }, include: { role: true } });
    }
    if (!admin?.isActive || admin.deletedAt || admin.role.name.toLowerCase() !== 'admin')
      throw new ActivationError('The specified account must be an active administrator. Nothing was applied.');

    const company = await tx.branding.findFirst({
      where: { type: 'COMPANY', isActive: true }, select: { name: true, email: true, phone: true },
    });
    const program = buildSmsProgram(company);
    const consentText = JSON.stringify({
      source: 'ADMIN_SCRIPT',
      channel: 'SMS',
      recordedBy: { id: admin.id, username: admin.username },
      recordedAt: now.toISOString(),
      basis: 'Administrator reports that existing users requested service and promotional SMS. Recorded administratively; not a Profile checkbox interaction.',
      program,
    });
    const users: ResultRow[] = [];
    for (const candidate of candidates) {
      const user = await tx.user.findUnique({ where: { id: candidate.id }, include: { smsConsent: true } });
      const row: ResultRow = { id: candidate.id, username: user?.username ?? '', service: 'ENABLE', promotional: 'ENABLE' };
      users.push(row);
      const skip = (reason: Action) => { row.service = row.promotional = reason; };
      if (!user) { skip('MISSING_USER'); continue; }
      if (!user.isActive || user.deletedAt) { skip('INACTIVE'); continue; }
      if (!supportsSmsPhone(user.phone)) { skip('UNSUPPORTED_PHONE'); continue; }
      if (user.smsConsent && user.smsConsent.phone !== user.phone) { skip('PHONE_CHANGED'); continue; }
      if (await tx.smsPhoneBlock.findUnique({ where: { phone: user.phone } })) { skip('STOP'); continue; }
      const history = await tx.smsConsentEvent.findMany({
        where: { OR: [{ userId: user.id }, { phone: user.phone }] },
        select: { action: true, category: true },
      });
      row.service = categoryAction(user.smsConsent, history, 'SERVICE');
      row.promotional = categoryAction(user.smsConsent, history, 'PROMOTIONAL');
      if (!options.apply || (row.service !== 'ENABLE' && row.promotional !== 'ENABLE')) continue;

      const data = {
        phone: user.phone,
        ...(row.service === 'ENABLE' ? {
          enabled: true, consentVersion: program.version, consentText, consentedAt: now, revokedAt: null,
        } : {}),
        ...(row.promotional === 'ENABLE' ? {
          promotionsEnabled: true, promotionsConsentVersion: program.version,
          promotionsConsentText: consentText, promotionsConsentedAt: now, promotionsRevokedAt: null,
        } : {}),
      };
      await tx.smsConsent.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data });
      for (const category of ['SERVICE', 'PROMOTIONAL'] as const) {
        if ((category === 'SERVICE' ? row.service : row.promotional) !== 'ENABLE') continue;
        await tx.smsConsentEvent.create({ data: {
          userId: user.id, phone: user.phone, action: 'OPT_IN', category,
          consentVersion: program.version, consentText, createdAt: now,
        } });
      }
    }
    return {
      mode: options.apply ? 'applied' : 'preview',
      changes: {
        users: users.filter(user => user.service === 'ENABLE' || user.promotional === 'ENABLE').length,
        service: users.filter(user => user.service === 'ENABLE').length,
        promotional: users.filter(user => user.promotional === 'ENABLE').length,
      },
      users,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 60_000 });
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  const options = parseSmsActivationArgs(args);
  let configured = process.env.DATABASE_URL;
  if (!configured) {
    try { configured = parseEnv(readFileSync(resolve(__dirname, '../.env'))).DATABASE_URL; }
    catch { throw new ActivationError('DATABASE_URL is missing and backend/.env could not be read.'); }
  }
  let database: URL;
  try { database = new URL(configured ?? ''); }
  catch { throw new ActivationError('A valid MySQL DATABASE_URL is required.'); }
  if (database.protocol !== 'mysql:' || !database.hostname || database.pathname.length < 2)
    throw new ActivationError('A valid MySQL DATABASE_URL is required.');

  const db = new PrismaClient({ datasources: { db: { url: configured } } });
  try {
    const result = await runExistingUserSmsActivation(db, options);
    console.log(JSON.stringify(result, null, 2));
  } finally { await db.$disconnect(); }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  // Driver errors/connection strings can contain credentials; do not print them.
  console.error(error instanceof ActivationError ? error.message :
    'Could not complete the SMS script. Check the database connection and schema, then review the preferences before retrying.');
  process.exitCode = 1;
});
