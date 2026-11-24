import { BadRequestException, ConflictException } from '@nestjs/common';
import { parseBrowserEvent, readAttributionHeader, registrationErrorBits, RegistrationAnalytics } from './registration-analytics';

import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersService } from '@/users/users.service';
import { RolesGuard } from './guards/roles/roles.guard';
import { RegistrationAnalyticsController } from './registration-analytics';
const request = require('supertest');

const id = 'ac518be0-50eb-45bd-838f-d87fd1d53e08';
describe('Campaign registration analytics', () => {
  it('preserves static keys and precise numeric campaign IDs, but never returns form values', () => {
    for (const campaign of ['registros_web', '9007199254740992', '9007199254740993']) {
      expect(readAttributionHeader(JSON.stringify({ id, campaign, ad: 'eva_es', email: 'test@example.invalid' })))
        .toEqual({ id, campaign, ad: 'eva_es' });
    }
    expect(readAttributionHeader('bad')).toBeNull();
    expect(parseBrowserEvent({ id, campaign: 'mail@example.invalid', stage: 'opened' })).toBeNull();
  });

  it('keeps untagged attribution distinct from named campaigns', () => {
    expect(readAttributionHeader(JSON.stringify({ id, campaign: '', ad: '' }))).toEqual({ id, campaign: '', ad: '' });
    expect(readAttributionHeader(JSON.stringify({ id, campaign: '', ad: 'eva_es' }))).toBeNull();
    expect(parseBrowserEvent({ id, campaign: '', stage: 'completed' })).toBeNull();
  });

  it('does not allow the public endpoint to send a completion', () => {
    expect(parseBrowserEvent({ id, campaign: 'registros_web', stage: 'completed' })).toBeNull();
    expect(parseBrowserEvent({ id, campaign: 'registros_web', stage: 'invalid' }))
      .toEqual({ id, campaign: 'registros_web', ad: '', stage: 3, errors: 1 });
  });

  it('records only a category of server error', () => {
    expect(registrationErrorBits(new BadRequestException('Do not record this string'))).toBe(2);
    expect(registrationErrorBits(new ConflictException({ code: 'PLATFORM_TERMS_REQUIRED' }))).toBe(4);
    expect(registrationErrorBits(new ConflictException('Do not record this string'))).toBe(8);
    expect(registrationErrorBits(new Error('private'))).toBe(16);
  });

  it('does not propagate analytics storage failure to signup', async () => {
    const db = { $executeRaw: jest.fn().mockRejectedValue(new Error('unavailable')) };
    await expect(new RegistrationAnalytics(db as never).record({ id, campaign: 'registros_web', ad: 'eva_en' }, 4))
      .resolves.toBeUndefined();
  });
});

describe('Registration analytics API boundary', () => {
  it('only measures a confirmed success and restricts reports to admins', async () => {
    const registerUser = jest.fn()
      .mockRejectedValueOnce(new ConflictException('Do not record this'))
      .mockResolvedValueOnce({ id: 123, deliveryAvailable: false })
      .mockRejectedValueOnce(new BadRequestException('Synthetic invalid address'))
      .mockResolvedValueOnce({ id: 124, deliveryAvailable: true })
      .mockResolvedValueOnce({ id: 125, deliveryAvailable: true });
    const record = jest.fn().mockResolvedValue(undefined);
    const report = jest.fn().mockResolvedValue({ days: 7, rows: [{ campaign: 'registros_web', ad: 'eva_es', completed: 1 }] });
    const module = await Test.createTestingModule({
      controllers: [AuthController, RegistrationAnalyticsController],
      providers: [
        { provide: AuthService, useValue: { registerUser } },
        { provide: UsersService, useValue: {} },
        { provide: RegistrationAnalytics, useValue: { record, report } },
        { provide: APP_GUARD, useValue: { canActivate(context) {
          const req = context.switchToHttp().getRequest();
          const role = req.headers['x-fixture-role'];
          if (role) req.user = { role: { name: role } };
          return true;
        }} },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    const app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    try {
      const api = request(app.getHttpServer());
      const attribution = { id, campaign: 'registros_web', ad: 'eva_es' };
      await api.post('/api/registration-analytics/event').send({ ...attribution, stage: 'completed' }).expect(400);
      await api.post('/api/registration-analytics/event').send({ ...attribution, stage: 'opened' }).expect(204);
      expect(record).toHaveBeenLastCalledWith(expect.objectContaining(attribution), 1, 0);
      const signup = (tags = attribution) => api.post('/api/auth/register')
        .set('x-registration-attribution', JSON.stringify(tags))
        .send({ email: 'fake@example.invalid' });
      await signup().expect(409);
      expect(record).toHaveBeenLastCalledWith(attribution, 3, 8);
      await signup().expect(201, { id: 123, deliveryAvailable: false });
      expect(record).toHaveBeenLastCalledWith(attribution, 4);
      const english = { ...attribution, id: 'ac518be0-50eb-45bd-838f-d87fd1d53e09', ad: 'eva_en' };
      await signup(english).expect(400);
      expect(record).toHaveBeenLastCalledWith(english, 3, 2);
      await signup(english).expect(201, { id: 124, deliveryAvailable: true });
      expect(record).toHaveBeenLastCalledWith(english, 4);
      const direct = { id: 'ac518be0-50eb-45bd-838f-d87fd1d53e10', campaign: '', ad: '' };
      await api.post('/api/registration-analytics/event').send({ ...direct, stage: 'opened' }).expect(204);
      expect(record).toHaveBeenLastCalledWith(expect.objectContaining(direct), 1, 0);
      await signup(direct).expect(201, { id: 125, deliveryAvailable: true });
      expect(record).toHaveBeenLastCalledWith(direct, 4);
      await api.get('/api/registration-analytics/report?days=7').expect(403);
      await api.get('/api/registration-analytics/report?days=7').set('x-fixture-role', 'operator').expect(403);
      await api.get('/api/registration-analytics/report?days=7').set('x-fixture-role', 'admin').expect(200);
      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(7);
    } finally { await app.close(); }
  });
});