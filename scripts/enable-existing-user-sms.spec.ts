// Offline validation only: no application, database connection, or SMS transport.
import * as assert from 'node:assert/strict';
import { parseSmsActivationArgs, runExistingUserSmsActivation } from './enable-existing-user-sms';

const now = new Date('2026-11-18T18:00:00.000Z');
const originalDate = new Date('2026-10-01T12:00:00.000Z');
const phone = '+13055551234';
const options = { adminUsername: 'operator.admin', apply: true };
const clone = <T>(value: T): T => structuredClone(value);

function user(id = 7, overrides: any = {}) {
  return { id, username: `user.${id}`, phone, isActive: true, deletedAt: null,
    role: { name: 'dealer' }, ...overrides };
}

function consent(id = 7, overrides: any = {}) {
  return {
    userId: id, phone, enabled: true, consentVersion: 'original-service-version',
    consentText: '{"source":"PROFILE","category":"SERVICE"}', consentedAt: originalDate,
    revokedAt: null, promotionsEnabled: true, promotionsConsentVersion: 'original-promotions-version',
    promotionsConsentText: '{"source":"PROFILE","category":"PROMOTIONAL"}',
    promotionsConsentedAt: originalDate, promotionsRevokedAt: null, updatedAt: originalDate,
    ...overrides,
  };
}

function fixture() {
  let users: any[] = [user(), user(99, { username: options.adminUsername,
    phone: '+13055559876', role: { name: 'admin' } })];
  let consents: any[] = [consent(99, { phone: '+13055559876' })];
  let events: any[] = [];
  let blocks: any[] = [];
  const writes: any[] = [];
  const transactions: any[] = [];
  const locks: unknown[][] = [];
  let failEvent = false;
  let afterSnapshot: (() => void) | undefined;
  let afterLock: (() => void) | undefined;
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      locks.push(args);
      afterLock?.();
      return users.map(({ id }) => ({ id }));
    },
    branding: { findFirst: async () => ({ name: 'Example Company', email: 'sales@example.test', phone }) },
    user: {
      findMany: async () => {
        const ids = users.map(({ id }) => ({ id })).sort((a, b) => a.id - b.id);
        afterSnapshot?.();
        return ids;
      },
      findUnique: async ({ where }: any) => {
        const found = users.find(row => where.id !== undefined ? row.id === where.id : row.username === where.username);
        return found ? clone({ ...found, smsConsent: consents.find(row => row.userId === found.id) ?? null }) : null;
      },
    },
    smsPhoneBlock: { findUnique: async ({ where }: any) => clone(blocks.find(row => row.phone === where.phone) ?? null) },
    smsConsentEvent: {
      findMany: async ({ where }: any) => clone(events.filter(event =>
        where.OR.some((condition: any) => condition.userId !== undefined
          ? event.userId === condition.userId : event.phone === condition.phone))),
      create: async ({ data }: any) => {
        if (failEvent) throw new Error('simulated audit failure');
        const event = { id: events.length + 1, ...clone(data) };
        events.push(event);
        writes.push({ event: clone(data) });
        return event;
      },
    },
    smsConsent: {
      upsert: async ({ where, create, update }: any) => {
        const existing = consents.find(row => row.userId === where.userId);
        if (existing) Object.assign(existing, clone(update));
        else consents.push({ enabled: false, promotionsEnabled: false, consentVersion: null,
          consentText: null, consentedAt: null, revokedAt: null, promotionsConsentVersion: null,
          promotionsConsentText: null, promotionsConsentedAt: null, promotionsRevokedAt: null,
          ...clone(create) });
        writes.push({ consent: { where: clone(where), create: clone(create), update: clone(update) } });
        return clone(consents.find(row => row.userId === where.userId));
      },
    },
  };
  const db = {
    ...tx,
    $transaction: async (callback: (client: typeof tx) => Promise<any>, settings: any) => {
      transactions.push(settings);
      const before = clone({ users, consents, events, blocks });
      try { return await callback(tx); }
      catch (error) {
        ({ users, consents, events, blocks } = before);
        throw error;
      }
    },
  };
  return {
    db, writes, transactions, locks,
    get users() { return users; }, get consents() { return consents; },
    get events() { return events; }, get blocks() { return blocks; },
    set failEvent(value: boolean) { failEvent = value; },
    set afterSnapshot(value: (() => void) | undefined) { afterSnapshot = value; },
    set afterLock(value: (() => void) | undefined) { afterLock = value; },
    run: (apply = true) => runExistingUserSmsActivation(db as never, { ...options, apply }, now),
  };
}

async function main() {
  assert.deepEqual(parseSmsActivationArgs(['--admin', options.adminUsername]), { ...options, apply: false });
  assert.deepEqual(parseSmsActivationArgs(['--admin', options.adminUsername, '--apply']), options);
  assert.throws(() => parseSmsActivationArgs([]));
  assert.throws(() => parseSmsActivationArgs(['--admin', options.adminUsername, '--unknown']));

  {
    const f = fixture();
    const before = clone(f.consents);
    const result = await f.run(false);
    assert.equal(result.mode, 'preview');
    assert.deepEqual(result.changes, { users: 1, service: 1, promotional: 1 });
    assert.deepEqual(f.consents, before);
    assert.equal(f.writes.length, 0);
    assert.equal(f.events.length, 0);
  }

  {
    const f = fixture();
    const result = await f.run();
    assert.equal(result.mode, 'applied');
    assert.deepEqual(result.changes, { users: 1, service: 1, promotional: 1 });
    const saved = f.consents.find(row => row.userId === 7);
    assert.equal(saved.enabled, true);
    assert.equal(saved.promotionsEnabled, true);
    assert.equal(saved.phone, phone);
    assert.deepEqual(saved.consentedAt, now);
    assert.deepEqual(saved.promotionsConsentedAt, now);
    assert.ok(saved.consentVersion && saved.promotionsConsentVersion);
    const proof = JSON.parse(saved.consentText);
    assert.equal(proof.source, 'ADMIN_SCRIPT');
    assert.ok(JSON.stringify(proof).includes(options.adminUsername));
    assert.equal(saved.consentText, saved.promotionsConsentText);
    assert.deepEqual(f.events.map(row => row.category).sort(), ['PROMOTIONAL', 'SERVICE']);
    assert.ok(f.events.every(row => row.action === 'OPT_IN' && row.userId === 7 && row.phone === phone && !row.providerMessageSid));
    assert.ok(f.locks.length > 0);
    assert.equal(f.transactions[0].isolationLevel, 'ReadCommitted');
    const after = clone({ consents: f.consents, events: f.events });
    const second = await f.run();
    assert.deepEqual(second.changes, { users: 0, service: 0, promotional: 0 });
    assert.deepEqual({ consents: f.consents, events: f.events }, after);
  }

  {
    const f = fixture();
    f.consents.push(consent(7, { promotionsEnabled: false, promotionsConsentVersion: null,
      promotionsConsentText: null, promotionsConsentedAt: null }));
    const original = clone(f.consents.find(row => row.userId === 7));
    const result = await f.run();
    assert.deepEqual(result.changes, { users: 1, service: 0, promotional: 1 });
    const saved = f.consents.find(row => row.userId === 7);
    for (const field of ['enabled', 'phone', 'consentVersion', 'consentText', 'consentedAt', 'revokedAt'])
      assert.deepEqual(saved[field], original[field], field);
    assert.deepEqual(f.events.map(row => row.category), ['PROMOTIONAL']);
  }

  for (const category of ['SERVICE', 'PROMOTIONAL']) {
    const f = fixture();
    f.events.push({ userId: 7, phone, action: 'OPT_OUT', category });
    const result = await f.run();
    const row = result.users.find(item => item.id === 7)!;
    assert.equal(category === 'SERVICE' ? row.service : row.promotional, 'PREVIOUS_OPT_OUT');
    assert.equal(category === 'SERVICE' ? row.promotional : row.service, 'ENABLE');
    const saved = f.consents.find(item => item.userId === 7);
    assert.equal(category === 'SERVICE' ? saved.enabled : saved.promotionsEnabled, false);
  }

  for (const category of [null, 'ALL']) {
    const f = fixture();
    f.events.push({ userId: 7, phone, action: 'OPT_OUT', category });
    const result = await f.run();
    assert.deepEqual(result.changes, { users: 0, service: 0, promotional: 0 });
    assert.equal(f.writes.length, 0);
  }

  for (const reason of ['INACTIVE', 'UNSUPPORTED_PHONE', 'PHONE_CHANGED', 'STOP']) {
    const f = fixture();
    if (reason === 'INACTIVE') f.users[0].isActive = false;
    if (reason === 'UNSUPPORTED_PHONE') f.users[0].phone = '+34612345678';
    if (reason === 'PHONE_CHANGED') f.consents.push(consent(7, { phone: '+13055559999' }));
    if (reason === 'STOP') f.blocks.push({ phone });
    const result = await f.run();
    const row = result.users.find(item => item.id === 7)!;
    assert.equal(row.service, reason);
    assert.equal(row.promotional, reason);
    assert.equal(f.writes.length, 0);
  }

  {
    const f = fixture();
    f.consents.push(consent(7, { enabled: false, revokedAt: originalDate,
      promotionsEnabled: false, promotionsRevokedAt: originalDate }));
    const result = await f.run();
    assert.deepEqual(result.changes, { users: 0, service: 0, promotional: 0 });
    assert.equal(f.writes.length, 0);
  }

  {
    const f = fixture();
    f.afterLock = () => f.events.push({ userId: 7, phone, action: 'OPT_OUT', category: 'ALL' });
    const result = await f.run();
    assert.deepEqual(result.changes, { users: 0, service: 0, promotional: 0 });
    assert.equal(f.writes.length, 0);
  }

  {
    const f = fixture();
    f.afterSnapshot = () => f.users.push(user(100, { phone: '+13055556789' }));
    const result = await f.run();
    assert.equal(result.users.some(row => row.id === 100), false);
    assert.equal(f.consents.some(row => row.userId === 100), false);
  }

  {
    const f = fixture();
    const before = clone({ consents: f.consents, events: f.events });
    f.failEvent = true;
    await assert.rejects(f.run(), /simulated audit failure/);
    assert.deepEqual({ consents: f.consents, events: f.events }, before);
  }

  for (const invalidAdmin of ['role', 'inactive', 'deleted']) {
    const f = fixture();
    const admin = f.users.find(row => row.id === 99)!;
    if (invalidAdmin === 'role') admin.role.name = 'dealer';
    if (invalidAdmin === 'inactive') admin.isActive = false;
    if (invalidAdmin === 'deleted') admin.deletedAt = now;
    await assert.rejects(f.run());
    assert.equal(f.writes.length, 0);
  }

  console.log('Existing-user SMS activation offline validation passed. No database connection or message send.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
