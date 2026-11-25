import { Test, TestingModule } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { UsersService } from '@/users/users.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './auth.tokens';

describe('AuthController', () => {
  let controller: AuthController;
  const auth = {
    registerUser: jest.fn(),
    validateUser: jest.fn(),
    newSessionId: jest.fn(),
    signAccessToken: jest.fn(),
    signRefreshToken: jest.fn(),
    createSession: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: UsersService, useValue: {} },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('starts the newly registered client session through email login and returns the tokens only in HTTP-only cookies', async () => {
    const registration = {
      firstName: 'Test', lastName: 'Client', email: 'client@example.test',
      phone: '+13055550100', password: 'example-password',
    };
    const account = { id: 42, username: 'test-client', email: registration.email, role: { name: 'client' } };
    const user = { ...account, passwordUpdatedAt: new Date('2026-01-01T00:00:00Z') };
    auth.registerUser.mockResolvedValue(account);
    auth.validateUser.mockResolvedValue(user);
    auth.newSessionId.mockReturnValue('client-session');
    auth.signAccessToken.mockResolvedValue('access-value');
    auth.signRefreshToken.mockResolvedValue('refresh-value');
    const request = { headers: { 'user-agent': 'test-browser' }, ip: '127.0.0.1' } as Request;
    const cookie = jest.fn();
    const response = { cookie } as unknown as Response;

    const registered = await controller.register(registration);
    expect(auth.registerUser).toHaveBeenCalledWith(registration);
    expect(registered).toEqual(account);
    expect(auth.createSession).not.toHaveBeenCalled();

    const result = await controller.login({ identifier: registered.email!, password: registration.password }, response, request);
    expect(auth.validateUser).toHaveBeenCalledWith(registration.email, registration.password);
    expect(auth.signAccessToken).toHaveBeenCalledWith(user, 'client-session');
    expect(auth.signRefreshToken).toHaveBeenCalledWith(registered.id, 'client-session', user.passwordUpdatedAt);
    expect(auth.createSession).toHaveBeenCalledTimes(1);
    expect(auth.createSession).toHaveBeenCalledWith({
      sessionId: 'client-session', userId: registered.id, refreshToken: 'refresh-value',
      userAgent: 'test-browser', ip: '127.0.0.1',
    });
    expect(cookie).toHaveBeenCalledTimes(2);
    expect(cookie).toHaveBeenCalledWith(ACCESS_COOKIE, 'access-value', expect.objectContaining({ httpOnly: true }));
    expect(cookie).toHaveBeenCalledWith(REFRESH_COOKIE, 'refresh-value', expect.objectContaining({ httpOnly: true }));
    expect(result).toEqual({ message: expect.any(String), role: 'client' });
  });
});
