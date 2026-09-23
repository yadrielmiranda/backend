import { randomUUID } from 'crypto';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './guards/roles/roles.guard';
import { AuthController } from './auth.controller';
import { UsersController } from '@/users/users.controller';
import { WarehouseController } from '@/warehouse/warehouse.controller';
import { TechnicianController } from '@/warehouse/technician.controller';
import { validateAccessSession } from './access-session';
import { presentApiResponse } from '@/common/response-privacy.interceptor';
import { needsPlatformTerms } from '@/platform-terms/platform-terms.policy';

const technician = { id: 3, role: { name: 'technician' as const } };
const allowed = (controller: any, method: string, role = 'technician') => new RolesGuard(new Reflector()).canActivate({
  getHandler: () => controller.prototype[method], getClass: () => controller,
  switchToHttp: () => ({ getRequest: () => ({ user: { id: 3, role: { name: role } } }) }),
} as any);

describe('Technician authentication and default-deny authorization', () => {
  it.each([
    'state',
    'pending',
    'scan',
    'receive',
    'deliverToInstallation',
    'currentPickup',
    'pickupPo',
    'startPickup',
    'pickupScan',
    'finishPickup',
  ])('allows the dedicated %s operation', (method) => {
    expect(allowed(TechnicianController, method)).toBe(true);
    for (const role of ['admin', 'operator', 'dealer', 'client']) expect(allowed(TechnicianController, method, role)).toBe(false);
  });
  it.each(['inventory', 'scan', 'receive', 'deliverToInstallation', 'history', 'stores', 'counts', 'undo', 'transfer'])('denies the administrative warehouse %s endpoint', (method) => {
    expect(allowed(WarehouseController, method)).toBe(false);
  });
  it('denies undecorated authenticated routes while preserving the existing roles', () => {
    class Existing { endpoint() {} }
    expect(allowed(Existing, 'endpoint')).toBe(false);
    for (const role of ['admin', 'operator', 'client', 'dealer']) expect(allowed(Existing, 'endpoint', role)).toBe(true);
    expect(allowed(AuthController, 'updateProfile')).toBe(false);
    expect(allowed(UsersController, 'deleteOwnUser')).toBe(false);
  });
  it.each(['getProfile', 'logout', 'changePassword'])('keeps the essential %s account operation available', (method) => {
    expect(allowed(AuthController, method)).toBe(true);
  });
  it.each(['createTechnician', 'updateTechnician'])('restricts account management (%s) to admin', (method) => {
    expect(allowed(UsersController, method, 'admin')).toBe(true);
    for (const role of ['technician', 'operator', 'dealer', 'client']) expect(allowed(UsersController, method, role)).toBe(false);
  });
  it('keeps PO identification but not financial or credential fields in technician responses', () => {
    const source = { poNumber: '281374', price: 999, rate: 50, markup: 2, password: 'hidden',
      stock: { poNumber: '281374', costoA: 4, rateReal: 5, netProfitD: 6, dealerMarkup: 7 } };
    const result = presentApiResponse(source, technician);
    expect(result.poNumber).toBe('281374'); expect(result.stock).toEqual({ poNumber: '281374' });
    for (const key of ['rate', 'markup', 'password']) expect(result).not.toHaveProperty(key);
    // La proyección de WarehouseService excluye prices; no elevar al técnico a staff en el interceptor.
    expect(presentApiResponse({ poNumber: '281374' }, { id: 2, role: { name: 'dealer' } })).toEqual({});
  });
  it('does not require platform terms for internal technicians', () => expect(needsPlatformTerms(technician)).toBe(false));
  it('does not issue a technician session to a dealer account', async () => {
    const service: any = { validateUser: jest.fn(async () => ({ role: { name: 'dealer' } })), createSession: jest.fn(), newSessionId: jest.fn() };
    const res: any = { cookie: jest.fn() };
    await expect(new AuthController(service, {} as any).technicianLogin({ identifier: 'dealer', password: 'password123' }, res, { headers: {} } as any)).rejects.toThrow('internal technician account');
    expect(service.createSession).not.toHaveBeenCalled(); expect(service.newSessionId).not.toHaveBeenCalled(); expect(res.cookie).not.toHaveBeenCalled();
  });
  it('accepts an active technician session with a null email and immediately enforces deactivation', async () => {
    const date = new Date(Date.now() - 1000), sid = randomUUID();
    const user: any = { id: 3, username: 'staff.one', firstName: 'Staff', lastName: 'One', email: null,
      role: { name: 'technician' }, isActive: true, deletedAt: null, passwordUpdatedAt: date };
    const db: any = { session: { findUnique: async () => ({ id: sid, userId: 3, user, revokedAt: null, expiresAt: new Date(Date.now() + 60000), lastUsedAt: new Date() }) } };
    const payload = { sub: 3, sid, tokenType: 'access' as const, passwordVersion: date.getTime(), exp: Math.floor(Date.now() / 1000) + 60 };
    expect(await validateAccessSession(db, payload)).toMatchObject({ id: 3, email: null, role: { name: 'technician' } });
    user.isActive = false; await expect(validateAccessSession(db, payload)).rejects.toThrow('no longer valid');
    user.isActive = true; user.passwordUpdatedAt = new Date(); await expect(validateAccessSession(db, payload)).rejects.toThrow('no longer valid');
  });
});
