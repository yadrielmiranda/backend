import { strict as assert } from 'node:assert';
import { types } from 'node:util';
import { AuthService } from './auth.service';
import { SmsConsentService } from '@/sms/sms-consent.service';
import { ValidationPipe } from '@nestjs/common';
import { RegisterUserDto } from './dto/register-user.dto';

// Se ejecuta el registro real con almacenamiento transaccional simulado.
function fixture() {
  const state: any = { users: [], registration: [], sms: [], events: [], blocks: [], fail: null, roleExists: true };
  const clone = (value: any) => structuredClone(value);
  const db: any = {
    branding: { findFirst: async () => ({ name: 'Authentic Evolution Co', email: 'support@example.com', phone: '+13055550100' }) },
    role: { findUnique: async () => state.roleExists ? { id: 3 } : null },
    user: {
      create: async ({ data, select }: any) => {
        if (state.users.some((user: any) => ['phone', 'email', 'username'].some((field) => user[field] === data[field]))) {
          throw Object.assign(new Error('Duplicate user'), { code: 'P2002' });
        }
        for (const field of ['serviceConsent', 'promotionsConsent', 'consentVersion']) assert(!(field in data));
        const user = { ...clone(data), id: state.users.length + 1, idRole: data.role.connect.id, isActive: true, deletedAt: null };
        state.users.push(user);
        return Object.fromEntries(Object.keys(select).map((key) => [key, clone(user[key])]));
      },
      findUnique: async ({ where }: any) => {
        const user = state.users.find((u: any) => u.id === where.id);
        return user ? { ...clone(user), smsConsent: clone(state.sms.find((s: any) => s.userId === user.id) ?? null) } : null;
      },
    },
    registrationConsent: { create: async ({ data }: any) => {
      if (state.fail === 'registration') throw new Error('Storage unavailable');
      state.registration.push(clone(data)); return clone(data);
    } },
    smsConsent: {
      create: async ({ data }: any) => {
        if (state.fail === 'sms') throw new Error('Storage unavailable');
        state.sms.push(clone(data)); return clone(data);
      },
      updateMany: async ({ where, data }: any) => {
        state.sms.filter((s: any) => s.phone === where.phone && s.enabled === where.enabled).forEach((s: any) => Object.assign(s, data));
      },
    },
    smsConsentEvent: {
      create: async ({ data }: any) => {
        if (state.fail === 'event') throw new Error('Storage unavailable');
        state.events.push(clone(data)); return clone(data);
      },
      findUnique: async ({ where }: any) => clone(state.events.find((e: any) => e.providerMessageSid === where.providerMessageSid) ?? null),
    },
    smsPhoneBlock: {
      findUnique: async ({ where }: any) => clone(state.blocks.find((b: any) => b.phone === where.phone) ?? null),
      upsert: async ({ create }: any) => state.blocks.push(clone(create)),
      deleteMany: async ({ where }: any) => { state.blocks = state.blocks.filter((b: any) => b.phone !== where.phone); },
    },
    $queryRaw: async (_strings: unknown, phone: string) => state.users.filter((u: any) => u.phone === phone).map((u: any) => ({ id: u.id })),
    $transaction: async (run: any) => {
      const previous = clone(state);
      try { return await run(db); } catch (error) { Object.assign(state, previous); throw error; }
    },
  };
  const sms = new SmsConsentService(db);
  const auth = new AuthService({} as any, db, {} as any, {} as any, {} as any, sms);
  const payload = async (extra: Record<string, unknown> = {}) => ({
    username: 'new-client', firstName: 'Test', lastName: 'Client',
    phone: '+13055551234', email: 'client@example.com', password: 'Example-only-123',
    street: '123 Example St', city: 'Miami', state: 'FL', postalCode: '33172',
    serviceConsent: true, promotionsConsent: false,
    consentVersion: (await sms.getProgram()).version, ...extra,
  });
  const register = async (extra: Record<string, unknown> = {}) => auth.registerUser(await payload(extra) as any);
  return { state, db, sms, auth, payload, register };
}

describe('Registration messaging consent', () => {
  it('keeps consent booleans strict through the real registration validation pipe', async () => {
    const f = fixture();
    const pipe = new ValidationPipe({ transform: true, whitelist: true, transformOptions: { enableImplicitConversion: true } });
    const metadata = { type: 'body' as const, metatype: RegisterUserDto };
    const accepted = await pipe.transform(await f.payload(), metadata);
    assert.equal(accepted.serviceConsent, true);
    assert.equal(accepted.promotionsConsent, false);
    for (const serviceConsent of [undefined, null, false, 'true', 'false', 1]) {
      await assert.rejects(pipe.transform(await f.payload({ serviceConsent }), metadata));
    }
    for (const promotionsConsent of [null, 'true', 'false', 1]) {
      await assert.rejects(pipe.transform(await f.payload({ promotionsConsent }), metadata));
    }
    const optional = await pipe.transform(await f.payload({ promotionsConsent: undefined }), metadata);
    assert.equal(optional.promotionsConsent, undefined);
  });

  it('rejects absent, false, or non-boolean service consent before creating an account', async () => {
    for (const serviceConsent of [undefined, null, false, 'true', 'false', 1, 0, [], {}]) {
      const f = fixture();
      await assert.rejects(f.register({ serviceConsent }), /must agree to service notifications/);
      assert.equal(f.state.users.length, 0);
      assert.equal(f.state.registration.length, 0);
    }
  });

  it('does not let promotional consent replace required service consent', async () => {
    const f = fixture();
    await assert.rejects(f.register({ serviceConsent: false, promotionsConsent: true }), /must agree/);
    assert.equal(f.state.sms.length, 0);
  });

  it('creates a client account with both service channels and promotions off', async () => {
    const f = fixture(); const user = await f.register();
    assert.equal(user.idRole, 3);
    assert.equal('password' in user, false);
    assert.notEqual(f.state.users[0].password, 'Example-only-123');
    const proof = f.state.registration[0];
    assert.equal(proof.userId, user.id);
    assert.equal(proof.phone, user.phone);
    assert.equal(proof.email, user.email);
    assert.equal(proof.serviceSmsAccepted, true);
    assert.equal(proof.serviceEmailAccepted, true);
    assert.equal(proof.promotionalSmsAccepted, false);
    assert.equal(proof.promotionalEmailAccepted, false);
    assert(types.isDate(proof.createdAt));
    const text = JSON.parse(proof.consentText);
    assert.equal(text.source, 'REGISTRATION');
    assert.equal(text.serviceConsent, true);
    assert.equal(text.promotionsConsent, false);
    assert.deepEqual(text.program, await f.sms.getProgram());
    assert.equal(f.state.sms[0].consentText, proof.consentText);
    assert.equal(f.state.events[0].consentText, proof.consentText);
    assert.equal((await f.sms.getPreferences(user.id)).enabled, true);
  });

  it('accepts registration when the optional promotions value is omitted', async () => {
    const f = fixture(); await f.register({ promotionsConsent: undefined });
    assert.equal(f.state.registration[0].promotionalSmsAccepted, false);
    assert.equal(f.state.registration[0].promotionalEmailAccepted, false);
  });

  it('records promotions only when explicitly accepted', async () => {
    const f = fixture(); await f.register({ promotionsConsent: true });
    assert.equal(f.state.registration[0].promotionalSmsAccepted, true);
    assert.equal(f.state.registration[0].promotionalEmailAccepted, true);
    assert.equal(JSON.parse(f.state.registration[0].consentText).promotionsConsent, true);
  });

  it('rejects malformed promotional flags instead of converting them to true', async () => {
    for (const promotionsConsent of [null, 'false', 'true', 0, 1, [], {}]) {
      const f = fixture();
      await assert.rejects(f.register({ promotionsConsent }), /must be a boolean/);
      assert.equal(f.state.users.length, 0);
    }
  });

  it('requires the exact current disclosure version', async () => {
    for (const consentVersion of [undefined, null, '', 'old', '0'.repeat(64)]) {
      const f = fixture();
      await assert.rejects(f.register({ consentVersion }), /messaging terms changed/);
      assert.equal(f.state.users.length, 0);
    }
  });

  it('does not create a partial account if any consent write fails', async () => {
    for (const failure of ['registration', 'sms', 'event']) {
      const f = fixture(); f.state.fail = failure;
      await assert.rejects(f.register());
      for (const field of ['users', 'registration', 'sms', 'events']) assert.equal(f.state[field].length, 0);
    }
  });

  it('preserves the original account and proof on duplicate registration', async () => {
    const f = fixture(); await f.register(); const before = JSON.stringify(f.state);
    await assert.rejects(f.register({ promotionsConsent: true }));
    assert.equal(JSON.stringify(f.state), before);
  });

  it('rejects registration for an existing STOP block without clearing it', async () => {
    const f = fixture(); f.state.blocks.push({ phone: '+13055551234' });
    await assert.rejects(f.register(), /STOP request/);
    assert.equal(f.state.users.length, 0);
    assert.equal(f.state.blocks.length, 1);
  });

  it('honors later STOP and START without rewriting the original acceptance', async () => {
    const f = fixture(); const user = await f.register({ promotionsConsent: true });
    const proof = structuredClone(f.state.registration[0]);
    await f.sms.recordProviderChoice(user.phone, 'SM' + '1'.repeat(32), 'STOP');
    assert.equal((await f.sms.getPreferences(user.id)).enabled, false);
    await f.sms.recordProviderChoice(user.phone, 'SM' + '2'.repeat(32), 'START');
    assert.equal((await f.sms.getPreferences(user.id)).enabled, false);
    assert.deepEqual(f.state.registration[0], proof);
  });

  it('creates no records if the client role is unavailable', async () => {
    const f = fixture(); f.state.roleExists = false;
    await assert.rejects(f.register());
    assert.equal(f.state.users.length, 0);
  });
});
