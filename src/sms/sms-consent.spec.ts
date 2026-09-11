import { strict as assert } from 'node:assert';
import { types } from 'node:util';
import { createHmac } from 'node:crypto';
import { SmsConsentService } from './sms-consent.service';
import { SmsConsentController } from './sms-consent.controller';
import { revokeSmsConsent } from './sms-consent.helpers';
import { validateTwilioSignature } from './twilio-signature';
import { UsersService } from '@/users/users.service';

// Dobles de almacenamiento: se prueban las decisiones reales del servicio.
function fixture() {
  const state: any = {
    users: [
      { id: 1, phone: '+13055551234', isActive: true, deletedAt: null, role: { name: 'client' }, idRole: 3 },
      { id: 2, phone: '+17865551234', isActive: true, deletedAt: null, role: { name: 'dealer' }, idRole: 2 },
    ],
    consents: [], events: [], blocks: [],
  };
  const copy = (value: any) => value == null ? value : structuredClone(value);
  const matches = (row: any, where: any = {}) => Object.entries(where).every(([key, value]) => row[key] === value);
  const userResult = (user: any) => user ? copy({ ...user, smsConsent: state.consents.find((c: any) => c.userId === user.id) ?? null }) : null;
  const db: any = {
    branding: { findFirst: async () => ({ name: 'Authentic Evolution Co', email: 'test@example.com', phone: '+13055550100' }) },
    user: {
      findUnique: async ({ where }: any) => userResult(state.users.find((u: any) => matches(u, where))),
      findFirst: async ({ where }: any) => userResult(state.users.find((u: any) => matches(u, where))),
      findUniqueOrThrow: async ({ where }: any) => { const u = userResult(state.users.find((u: any) => matches(u, where))); if (!u) throw new Error('Missing user'); return u; },
      update: async ({ where, data }: any) => {
        const user = state.users.find((u: any) => matches(u, where));
        if (!user) throw new Error('Missing user');
        Object.assign(user, data);
        return userResult(user);
      },
    },
    smsConsent: {
      findUnique: async ({ where }: any) => copy(state.consents.find((c: any) => matches(c, where)) ?? null),
      upsert: async ({ where, create, update }: any) => {
        let row = state.consents.find((c: any) => matches(c, where));
        if (row) Object.assign(row, update); else state.consents.push(row = copy(create));
        return copy(row);
      },
      update: async ({ where, data }: any) => {
        const row = state.consents.find((c: any) => matches(c, where));
        if (!row) throw new Error('Missing consent');
        Object.assign(row, data); return copy(row);
      },
      updateMany: async ({ where, data }: any) => {
        const rows = state.consents.filter((c: any) => matches(c, where));
        rows.forEach((row: any) => Object.assign(row, data)); return { count: rows.length };
      },
    },
    smsConsentEvent: {
      findUnique: async ({ where }: any) => copy(state.events.find((e: any) => matches(e, where)) ?? null),
      create: async ({ data }: any) => {
        if (data.providerMessageSid && state.events.some((e: any) => e.providerMessageSid === data.providerMessageSid)) throw Object.assign(new Error('Duplicate SID'), { code: 'P2002' });
        state.events.push(copy(data)); return copy(data);
      },
    },
    smsPhoneBlock: {
      findUnique: async ({ where }: any) => copy(state.blocks.find((b: any) => matches(b, where)) ?? null),
      upsert: async ({ where, create, update }: any) => {
        const row = state.blocks.find((b: any) => matches(b, where));
        if (row) Object.assign(row, update); else state.blocks.push(copy(create));
      },
      deleteMany: async ({ where }: any) => { state.blocks = state.blocks.filter((b: any) => !matches(b, where)); },
    },
    session: { updateMany: async () => ({ count: 1 }) },
    $queryRaw: async (strings: TemplateStringsArray, value: string | number) => state.users.filter((u: any) => strings.join('').includes('WHERE phone') ? u.phone === value : u.id === value).map((u: any) => ({ id: u.id })),
    $transaction: async (callback: any) => {
      const previous = copy(state);
      try { return await callback(db); } catch (error) { Object.assign(state, previous); throw error; }
    },
  };
  db.branding.updateMany = async () => ({ count: 0 });
  const service = new SmsConsentService(db);
  const subscribe = async (userId = 1) => {
    const prefs = await service.getPreferences(userId);
    return service.updatePreferences(userId, { enabled: true, phone: prefs.phone, version: prefs.program.version });
  };
  return { state, db, service, subscribe };
}

describe('SMS consent', () => {
  it('starts off and reads without creating consent', async () => {
    const f = fixture();
    assert.equal((await f.service.getPreferences(1)).enabled, false);
    assert.equal(f.state.consents.length, 0);
    assert.equal(f.state.events.length, 0);
  });

  it('records the exact program, number, user, and timestamp only after acceptance', async () => {
    const f = fixture(); const result = await f.subscribe();
    assert.equal(result.enabled, true);
    assert.equal(f.state.events[0].userId, 1);
    assert.equal(f.state.events[0].phone, result.phone);
    assert.deepEqual(JSON.parse(f.state.events[0].consentText).program, result.program);
    assert.equal(f.state.events[0].category, 'SERVICE');
    assert(types.isDate(f.state.events[0].createdAt));
    assert.equal((await f.service.getPreferences(2)).enabled, false);
  });

  it('does not duplicate an unchanged acceptance', async () => {
    const f = fixture(); await f.subscribe(); await f.subscribe();
    assert.equal(f.state.events.length, 1);
  });

  it('preserves previous proof when opting out and back in', async () => {
    const f = fixture(); await f.subscribe(); const proof = f.state.events[0].consentText;
    await f.service.updatePreferences(1, { enabled: false });
    assert.equal((await f.service.getPreferences(1)).enabled, false);
    await f.subscribe();
    assert.deepEqual(f.state.events.map((e: any) => e.action), ['OPT_IN', 'OPT_OUT', 'OPT_IN']);
    assert.equal(f.state.events[0].consentText, proof);
  });

  it('rejects strings, null, and omitted booleans instead of treating them as consent', async () => {
    const f = fixture();
    for (const value of ['false', 'true', 1, null, undefined]) {
      await assert.rejects(f.service.updatePreferences(1, { enabled: value }), /boolean/);
    }
    assert.equal(f.state.events.length, 0);
  });

  it('rejects a different phone and stale policy without changing records', async () => {
    const f = fixture(); const prefs = await f.service.getPreferences(1);
    await assert.rejects(f.service.updatePreferences(1, { enabled: true, phone: '+17865551234', version: prefs.program.version }), /phone number/);
    await assert.rejects(f.service.updatePreferences(1, { enabled: true, phone: prefs.phone, version: 'old' }), /terms changed/);
    assert.equal(f.state.events.length, 0);
  });

  it('does not allow deleted or inactive accounts to opt in', async () => {
    const f = fixture(); f.state.users[0].isActive = false;
    await assert.rejects(f.subscribe(), /inactive/);
    f.state.users[0].isActive = true; f.state.users[0].deletedAt = new Date();
    await assert.rejects(f.service.updatePreferences(1, { enabled: true }), /inactive/);
  });

  it('rolls back consent if recording the proof fails', async () => {
    const f = fixture(); f.db.smsConsentEvent.create = async () => { throw new Error('Storage unavailable'); };
    await assert.rejects(f.subscribe(), /Storage unavailable/);
    assert.equal(f.state.consents.length, 0);
  });

  it('revokes on a real profile phone change and never restores by changing back', async () => {
    const f = fixture(); await f.subscribe();
    const users = new UsersService(f.db, {} as any);
    await users.updateUser({ where: { id: 1 }, data: { phone: '+13055559876' } });
    assert.equal((await f.service.getPreferences(1)).enabled, false);
    assert.equal(f.state.events.at(-1).action, 'PHONE_CHANGED');
    await users.updateUser({ where: { id: 1 }, data: { phone: '+13055551234' } });
    assert.equal((await f.service.getPreferences(1)).enabled, false);
  });

  it('keeps consent for unrelated profile edits and revokes it when deactivated', async () => {
    const f = fixture(); await f.subscribe(); const users = new UsersService(f.db, {} as any);
    await users.updateUser({ where: { id: 1 }, data: { firstName: 'New name', phone: '+13055551234' } });
    assert.equal((await f.service.getPreferences(1)).enabled, true);
    await users.updateUser({ where: { id: 1 }, data: { isActive: false } });
    assert.equal(f.state.consents[0].enabled, false);
    assert.equal(f.state.events.at(-1).action, 'ACCOUNT_DISABLED');
  });

  it('revokes consent when the account is deleted', async () => {
    const f = fixture(); await f.subscribe();
    await new UsersService(f.db, {} as any).deleteUser({ id: 1 });
    assert.equal(f.state.consents[0].enabled, false);
    assert.equal(f.state.events.at(-1).action, 'ACCOUNT_DISABLED');
  });

  it('handles signed provider STOP, deduplicates it, and requires a new profile opt-in after START', async () => {
    const f = fixture(); await f.subscribe(); await f.subscribe(2);
    const sid = 'SM' + '1'.repeat(32);
    await f.service.recordProviderChoice('+13055551234', sid, 'STOP');
    await f.service.recordProviderChoice('+13055551234', sid, 'STOP');
    assert.equal((await f.service.getPreferences(1)).blockedBySms, true);
    assert.equal((await f.service.getPreferences(2)).enabled, true);
    assert.equal(f.state.events.filter((e: any) => e.action === 'PROVIDER_STOP').length, 1);
    await assert.rejects(f.subscribe(), /STOP request/);
    await f.service.recordProviderChoice('+13055551234', 'SM' + '2'.repeat(32), 'START');
    assert.equal((await f.service.getPreferences(1)).enabled, false);
    await f.subscribe();
    // Un reintento atrasado del mismo STOP no anula una nueva autorización.
    await f.service.recordProviderChoice('+13055551234', sid, 'STOP');
    assert.equal((await f.service.getPreferences(1)).enabled, true);
  });

  it('remembers STOP for numbers without an account', async () => {
    const f = fixture();
    await f.service.recordProviderChoice('+13055559999', 'SM' + '3'.repeat(32), 'STOP');
    assert.equal(f.state.events[0].userId, null);
    f.state.users[0].phone = '+13055559999';
    await assert.rejects(f.subscribe(), /STOP request/);
  });

  it('records a provider opt-out rejection without a MessageSid and keeps the account active', async () => {
    const f = fixture(); await f.subscribe();
    await f.service.recordProviderChoice('+13055551234', null, 'STOP');
    const prefs = await f.service.getPreferences(1);
    assert.equal(prefs.enabled, false);
    assert.equal(prefs.blockedBySms, true);
    assert.equal(f.state.events.at(-1).action, 'PROVIDER_STOP');
    assert.equal(f.state.events.at(-1).providerMessageSid, null);
    assert.equal(f.state.users[0].isActive, true);
    await assert.rejects(f.subscribe(), /STOP request/);
  });

  it('preserves an existing service acceptance and date after program text changes', async () => {
    const f = fixture(); await f.subscribe();
    f.state.consents[0].consentVersion = 'legacy-version';
    f.state.consents[0].consentText = 'legacy-proof';
    const before = structuredClone(f.state.consents[0]);
    const eventCount = f.state.events.length;
    assert.equal((await f.service.getPreferences(1)).enabled, true);
    await f.service.updatePreferences(1, { enabled: true });
    assert.deepEqual(f.state.consents[0], before);
    assert.equal(f.state.events.length, eventCount);
  });

  it('edits promotions without changing existing service consent or its historical version', async () => {
    const f = fixture(); await f.subscribe();
    f.state.consents[0].consentVersion = 'legacy-version';
    const original = structuredClone(f.state.consents[0]);
    const prefs = await f.service.getPreferences(1);
    await f.service.updatePreferences(1, { enabled: true, promotionsEnabled: true, phone: prefs.phone, version: prefs.program.version });
    for (const field of ['enabled', 'phone', 'consentVersion', 'consentText', 'consentedAt', 'revokedAt']) {
      assert.deepEqual(f.state.consents[0][field], original[field]);
    }
    assert.equal((await f.service.getPreferences(1)).promotionsEnabled, true);
    assert.equal(f.state.events.at(-1).category, 'PROMOTIONAL');
  });

  it('keeps promotions enabled when service SMS is turned off, and vice versa', async () => {
    const f = fixture(); const prefs = await f.service.getPreferences(1);
    const proof = { phone: prefs.phone, version: prefs.program.version };
    await f.service.updatePreferences(1, { enabled: false, promotionsEnabled: true, ...proof });
    assert.equal((await f.service.getPreferences(1)).enabled, false);
    assert.equal((await f.service.getPreferences(1)).promotionsEnabled, true);
    await f.service.updatePreferences(1, { enabled: true, ...proof });
    await f.service.updatePreferences(1, { enabled: false });
    assert.equal((await f.service.getPreferences(1)).promotionsEnabled, true);
    await f.service.updatePreferences(1, { enabled: true, promotionsEnabled: false, ...proof });
    assert.equal((await f.service.getPreferences(1)).enabled, true);
    assert.equal((await f.service.getPreferences(1)).promotionsEnabled, false);
  });

  it('allows either opt-out without forcing acceptance of new terms', async () => {
    const f = fixture(); const prefs = await f.service.getPreferences(1);
    await f.service.updatePreferences(1, { enabled: true, promotionsEnabled: true, phone: prefs.phone, version: prefs.program.version });
    await f.service.updatePreferences(1, { enabled: false, promotionsEnabled: false, version: 'old' });
    assert.equal((await f.service.getPreferences(1)).enabled, false);
    assert.equal((await f.service.getPreferences(1)).promotionsEnabled, false);
  });

  it('rejects non-boolean promotional preferences and stale promotions-only opt-ins', async () => {
    const f = fixture(); const prefs = await f.service.getPreferences(1);
    for (const value of [null, 'false', 'true', 0, 1, [], {}]) {
      await assert.rejects(f.service.updatePreferences(1, { enabled: false, promotionsEnabled: value }), /boolean/);
    }
    await assert.rejects(f.service.updatePreferences(1, { enabled: false, promotionsEnabled: true, phone: prefs.phone, version: 'old' }), /terms changed/);
    assert.equal(f.state.events.length, 0);
  });

  it('STOP disables both categories and START does not silently resubscribe either', async () => {
    const f = fixture(); const prefs = await f.service.getPreferences(1);
    await f.service.updatePreferences(1, { enabled: true, promotionsEnabled: true, phone: prefs.phone, version: prefs.program.version });
    await f.service.recordProviderChoice(prefs.phone, 'SM' + '4'.repeat(32), 'STOP');
    assert.equal((await f.service.getPreferences(1)).enabled, false);
    assert.equal((await f.service.getPreferences(1)).promotionsEnabled, false);
    assert.equal(f.state.events.at(-1).category, 'ALL');
    await f.service.recordProviderChoice(prefs.phone, 'SM' + '5'.repeat(32), 'START');
    assert.equal((await f.service.getPreferences(1)).promotionsEnabled, false);
    await f.service.updatePreferences(1, { enabled: false, promotionsEnabled: true, phone: prefs.phone, version: prefs.program.version });
    assert.equal((await f.service.getPreferences(1)).enabled, false);
  });

  it('revokes promotional-only consent on a phone change or account deactivation', async () => {
    for (const action of ['PHONE_CHANGED', 'ACCOUNT_DISABLED'] as const) {
      const f = fixture(); const prefs = await f.service.getPreferences(1);
      await f.service.updatePreferences(1, { enabled: false, promotionsEnabled: true, phone: prefs.phone, version: prefs.program.version });
      await revokeSmsConsent(f.db, 1, action);
      assert.equal((await f.service.getPreferences(1)).promotionsEnabled, false);
      assert.equal(f.state.events.at(-1).category, 'PROMOTIONAL');
      assert.equal(f.state.events.at(-1).action, action);
    }
  });

  it('retains the number and policy in phone-change audit records', async () => {
    const f = fixture(); await f.subscribe();
    await revokeSmsConsent(f.db, 1, 'PHONE_CHANGED');
    assert.equal(f.state.events[1].phone, '+13055551234');
    assert.equal(f.state.events[1].consentVersion, f.state.events[0].consentVersion);
  });
});

describe('Twilio callback authentication', () => {
  const account = 'AC' + 'a'.repeat(32);
  const messagingService = 'MG' + 'b'.repeat(32);
  const url = 'https://api.example.com/api/sms/twilio/incoming';
  const token = 'unit-test-token';
  const sign = (body: Record<string, string>) => createHmac('sha1', token).update(Object.keys(body).sort().reduce((text, key) => text + key + body[key], url)).digest('base64');
  const body = { AccountSid: account, MessagingServiceSid: messagingService, From: '+13055551234', To: '+13055550100', MessageSid: 'SM' + 'c'.repeat(32), OptOutType: 'STOP', Body: 'STOP' };
  const request = (data: Record<string, string>, signature = sign(data)) => ({ body: data, is: () => true, get: () => signature }) as any;
  function controller() {
    const f = fixture();
    const config = { TWILIO_ACCOUNT_SID: account, TWILIO_AUTH_TOKEN: token, TWILIO_INBOUND_WEBHOOK_URL: url, TWILIO_MESSAGING_SERVICE_SID: messagingService };
    return { ...f, controller: new SmsConsentController(f.service, { get: (key: string) => config[key] } as any) };
  }

  it('matches the published signature example and rejects modifications', () => {
    const params = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675310', Digits: '1234', From: '+14158675310', To: '+18005551212' };
    assert(validateTwilioSignature('12345', 'https://example.com/myapp.php?foo=1&bar=2', 'L/OH5YylLD5NRKLltdqwSvS0BnU=', params));
    assert.equal(validateTwilioSignature('12345', 'https://example.com/myapp.php?foo=1&bar=2', 'L/OH5YylLD5NRKLltdqwSvS0BnU=', { ...params, Digits: '4321' }), false);
  });

  it('validates the entire body including extra Twilio fields', () => {
    const params = { ...body, NewField: 'new data' };
    assert(validateTwilioSignature(token, url, sign(params), params));
    assert.equal(validateTwilioSignature(token, url, sign(body), params), false);
    assert.equal(validateTwilioSignature(token, url, sign(body), { ...body, Body: ['STOP'] }), false);
  });

  it('accepts authentic STOP and returns empty TwiML without sending a second reply', async () => {
    const f = controller(); await f.subscribe();
    const response = await f.controller.receiveTwilio(request(body));
    assert.match(response, /<Response><\/Response>/);
    assert.equal((await f.service.getPreferences(1)).enabled, false);
  });

  it('rejects missing, tampered, and unrelated-account callbacks', async () => {
    const f = controller();
    await assert.rejects(f.controller.receiveTwilio(request(body, '')), /Invalid SMS callback/);
    await assert.rejects(f.controller.receiveTwilio(request({ ...body, From: '+17865551234' }, sign(body))), /Invalid SMS callback/);
    await assert.rejects(f.controller.receiveTwilio(request({ ...body, AccountSid: 'AC' + 'f'.repeat(32) })), /Invalid SMS callback/);
    await assert.rejects(f.controller.receiveTwilio(request({ ...body, MessagingServiceSid: 'MG' + 'f'.repeat(32) })), /Invalid SMS callback/);
    assert.equal(f.state.events.length, 0);
  });

  it('does not process callbacks until configured and does not treat HELP as consent', async () => {
    const f = controller();
    await assert.rejects(new SmsConsentController(f.service, { get: () => undefined } as any).receiveTwilio(request(body)), /not configured/);
    await f.controller.receiveTwilio(request({ ...body, OptOutType: 'HELP', Body: 'HELP' }));
    assert.equal(f.state.events.length, 0);
  });

  it('always changes the authenticated user regardless of a supplied user id', async () => {
    const f = controller(); const prefs = await f.service.getPreferences(1);
    await f.controller.updatePreferences({ user: { id: 1 } } as any, { userId: 2, enabled: true, phone: prefs.phone, version: prefs.program.version } as any);
    assert.equal((await f.service.getPreferences(1)).enabled, true);
    assert.equal((await f.service.getPreferences(2)).enabled, false);
  });
});
