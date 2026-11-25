import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { DealerRegistrationService } from './dealer-registration.service';
import { applyDealerRegistrationConsent, captureDealerRegistrationConsent } from './dealer-registration-consent';

jest.mock('./dealer-registration-consent', () => ({
  ...jest.requireActual('./dealer-registration-consent'),
  captureDealerRegistrationConsent: jest.fn(),
  applyDealerRegistrationConsent: jest.fn(),
}));

const actor = (id: number, name = 'dealer') => ({ id, role: { name } } as AuthUser);
const role = { id: 3, name: 'dealer', markup: new Prisma.Decimal('0.10') };
const person = {
  firstName: 'Test', lastName: 'Installer', username: 'test.installer', email: 'test@example.test',
  phone: '+13055551234', street: '100 Example St', addressLine2: 'Suite 2', city: 'Miami',
  state: 'FL', postalCode: '33101', password: 'example-password',
  companyName: 'Example Glass', estimatedMonthlySales: 2500.25, yearsOfExperience: 0,
};

function fixture(parentDealerId: number | null) {
  jest.mocked(captureDealerRegistrationConsent).mockReset();
  jest.mocked(applyDealerRegistrationConsent).mockReset();
  const members = new Map([1, 2, 3, 4].map((id) => [
    id, { id, username: `network${id}`, idRole: role.id, role, dealerMode: 'EXTERNAL',
      parentDealerId: id === 2 ? 1 : id === 3 ? 2 : null,
      isActive: true, deletedAt: null, networkSuspended: false },
  ]));
  const invite = {
    id: 10, token: 'd'.repeat(64), parentDealerId,
    scopeKey: parentDealerId === null ? 'company' : `dealer:${parentDealerId}`,
    markupPercent: new Prisma.Decimal('12.5'),
  };
  const request = {
    ...person, password: undefined, passwordHash: 'stored-password-hash', id: 20,
    inviteId: invite.id, invite, createdAt: new Date(), markupPercent: new Prisma.Decimal('12.5'),
  };
  const db = {
    $transaction: jest.fn(), $queryRaw: jest.fn().mockResolvedValue([{ id: 20 }]),
    role: { findUnique: jest.fn().mockResolvedValue(role) },
    user: {
      findUnique: jest.fn().mockImplementation(async ({ where }) => members.get(where.id) ?? null),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 80, username: person.username, parentDealerId }),
    },
    dealerRegistrationInvite: {
      findUnique: jest.fn().mockResolvedValue(invite),
      upsert: jest.fn().mockResolvedValue(invite),
    },
    dealerRegistrationRequest: {
      create: jest.fn(async ({ data }) => ({ id: request.id, username: data.username })),
      findUnique: jest.fn().mockImplementation(async ({ where }) => where.id === request.id ? request : null),
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(request),
    },
  };
  db.$transaction.mockImplementation((run) => run(db));
  const logs = { log: jest.fn() };
  const welcome = { enqueue: jest.fn() };
  const notifications = { createAndSend: jest.fn(), createAndSendToRoles: jest.fn() };
  const rejections = { enqueue: jest.fn() };
  const service = new DealerRegistrationService(db as never, logs as never, welcome as never,
    notifications as never, rejections as never);
  return { db, service, members, invite, request, welcome, logs, notifications, rejections };
}

describe('Dealer invitation registration', () => {
  it('keeps company invitations free of an individual inviter', async () => {
    const { service, db, invite } = fixture(null);
    await expect(service.publicInvitation(invite.token)).resolves.toEqual({ level: 'Dealer', inviter: null });
    expect(db.user.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it.each([
    { branding: { name: 'Coastal Glass', logoUrl: '/uploads/branding/coastal.png' },
      inviter: { name: 'Coastal Glass', logoUrl: '/uploads/branding/coastal.png' } },
    { branding: { name: 'Coastal Glass', logoUrl: null }, inviter: { name: 'Coastal Glass', logoUrl: null } },
    { branding: null, inviter: { name: 'Ana Reyes', logoUrl: null } },
    { branding: { name: ' ', logoUrl: '/uploads/example.png' }, inviter: { name: 'Ana Reyes', logoUrl: null } },
  ])('shows the direct subdealer on a distributor invitation: $inviter.name', async ({ branding, inviter }) => {
    const { service, db, invite } = fixture(2);
    db.user.findUniqueOrThrow.mockResolvedValue({ firstName: 'Ana', lastName: 'Reyes', branding });
    await expect(service.publicInvitation(invite.token)).resolves.toEqual({ level: 'Distributor', inviter });
    expect(db.user.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 2 },
      select: {
        firstName: true, lastName: true,
        branding: { where: { type: 'DEALER', isActive: true }, select: { name: true, logoUrl: true } },
      },
    });
  });

  it.each(['operator', 'client', 'technician'])('prevents %s from issuing invitations', async (name) => {
    const { service, db } = fixture(null);
    await expect(service.getInvitation(actor(9, name))).rejects.toThrow(ForbiddenException);
    await expect(service.saveInvitation(actor(9, name), 10)).rejects.toThrow(ForbiddenException);
    expect(db.dealerRegistrationInvite.upsert).not.toHaveBeenCalled();
  });

  it('prevents a distributor from issuing invitations', async () => {
    const { service, db } = fixture(3);
    await expect(service.saveInvitation(actor(3), 10)).rejects.toThrow();
    expect(db.dealerRegistrationInvite.upsert).not.toHaveBeenCalled();
  });

  it('retains all 24 significant digits between the company role, invitation percentage and approved account', async () => {
    const { db, invite, request, service } = fixture(null);
    const admin = actor(9, 'admin');
    const ratio = '123456.789012345678901234';
    const percent = '12345678.9012345678901234';
    db.role.findUnique.mockResolvedValue({ ...role, markup: new Prisma.Decimal(ratio) });
    db.dealerRegistrationInvite.findUnique.mockResolvedValueOnce(null);
    expect(await service.getInvitation(admin)).toMatchObject({ token: null, markupPercent: percent });
    invite.markupPercent = new Prisma.Decimal(percent);
    await service.review(admin, request.id, true);
    expect(db.user.create.mock.calls[0][0].data.markupOverride.toFixed()).toBe(ratio);
  });

  it('saves the submitted terms and a password hash without creating an account', async () => {
    const { service, db, invite, welcome } = fixture(1);
    await expect(service.submit(invite.token, person)).resolves.toEqual({ id: 20, username: person.username });
    const [{ data }] = db.dealerRegistrationRequest.create.mock.calls[0];
    expect(data).toMatchObject({
      inviteId: invite.id, companyName: 'Example Glass', yearsOfExperience: 0,
    });
    expect(String(data.estimatedMonthlySales)).toBe('2500.25');
    expect(String(data.markupPercent)).toBe('12.5');
    expect(data).not.toHaveProperty('password');
    expect(await bcrypt.compare(person.password, data.passwordHash)).toBe(true);
    expect(captureDealerRegistrationConsent).toHaveBeenCalledWith(db, person);
    expect(db.user.create).not.toHaveBeenCalled();
    expect(welcome.enqueue).not.toHaveBeenCalled();
  });

  it('keeps the available name through submission and approval under the inviting dealer', async () => {
    const { db, service, invite, request, notifications } = fixture(1);
    db.dealerRegistrationRequest.findMany.mockResolvedValueOnce([{ username: 'TESTINSTALLER2' }]);
    db.user.findMany.mockResolvedValueOnce([{ username: 'TestInstaller' }]);
    const submitted = await service.submit(invite.token, { ...person, username: undefined });
    expect(submitted).toEqual({ id: request.id, username: 'TestInstaller3' });
    expect(db.dealerRegistrationRequest.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ username: submitted.username, inviteId: invite.id }),
    }));
    expect(notifications.createAndSend).toHaveBeenCalledWith(expect.objectContaining({
      recipientId: 1, message: expect.stringContaining('TestInstaller3'),
    }), db);
    request.username = submitted.username;
    await service.review(actor(1), submitted.id, true);
    expect(db.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ username: submitted.username, password: request.passwordHash, parentDealerId: 1 }),
    }));
  });

  it('chooses the next name when another request claimed the first available candidate', async () => {
    const { db, service, invite } = fixture(null);
    db.dealerRegistrationRequest.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('Already claimed', {
      code: 'P2002', clientVersion: 'test', meta: { target: 'DealerRegistrationRequest_username_key' },
    }));
    const saved = await service.submit(invite.token, { ...person, username: undefined });
    expect(saved.username).toBe('TestInstaller2');
    expect(db.dealerRegistrationRequest.create.mock.calls.map(([{ data }]) => data.username)).toEqual(['TestInstaller', 'TestInstaller2']);
  });

  it('still sees a name moved from pending requests to accounts by a concurrent approval', async () => {
    const { db, service, invite } = fixture(null);
    let approved = false;
    db.dealerRegistrationRequest.findMany.mockImplementationOnce(async () => {
      approved = true;
      return [];
    });
    db.user.findMany.mockImplementationOnce(async () => approved ? [{ username: 'TestInstaller' }] : []);
    const saved = await service.submit(invite.token, { ...person, username: undefined });
    expect(saved.username).toBe('TestInstaller2');
  });

  it('retries a generated name claimed by an unrelated account before the pending request commits', async () => {
    const { db, service, invite, notifications } = fixture(null);
    db.user.findUnique.mockResolvedValueOnce({ id: 21 });
    const saved = await service.submit(invite.token, { ...person, username: undefined });
    expect(saved.username).toBe('TestInstaller2');
    expect(db.dealerRegistrationRequest.delete).toHaveBeenCalledWith({ where: { id: 20 } });
    expect(notifications.createAndSendToRoles).toHaveBeenCalledTimes(1);
  });

  it('does not generate usernames again for a conflicting email or phone', async () => {
    const { db, service, invite } = fixture(null);
    db.user.findFirst.mockResolvedValueOnce({ id: 21 });
    await expect(service.submit(invite.token, { ...person, username: undefined })).rejects.toThrow('email or phone');
    expect(db.dealerRegistrationRequest.create).toHaveBeenCalledTimes(1);
  });

  it.each(['pending request', 'account'])('identifies a custom username conflict with an existing %s', async source => {
    const { db, service, invite, notifications } = fixture(null);
    if (source === 'pending request') db.dealerRegistrationRequest.findUnique.mockResolvedValueOnce({ id: 19 });
    else db.user.findUnique.mockResolvedValueOnce({ id: 21 });
    await expect(service.submit(invite.token, person)).rejects.toMatchObject({
      response: { code: 'USERNAME_TAKEN', field: 'username' },
    });
    expect(notifications.createAndSendToRoles).not.toHaveBeenCalled();
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('keeps consent and terms evidence private to the approval transaction', async () => {
    const { db, service } = fixture(null);
    await service.listPending(actor(9, 'admin'));
    const [{ select }] = db.dealerRegistrationRequest.findMany.mock.calls[0];
    for (const field of ['serviceSmsAccepted', 'promotionalSmsAccepted', 'smsConsentVersion',
      'smsConsentText', 'smsConsentedAt', 'termsVersionId', 'termsAcceptedAt']) {
      expect(select).not.toHaveProperty(field);
    }
  });

  it('shows the current markup on a previously submitted request without exposing its invitation', async () => {
    const { db, service, invite, request } = fixture(null);
    invite.markupPercent = new Prisma.Decimal('16.375');
    db.dealerRegistrationRequest.findMany.mockResolvedValueOnce([{
      id: request.id, markupPercent: request.markupPercent, invite: { markupPercent: invite.markupPercent },
    }]);
    const [pending] = await service.listPending(actor(9, 'admin'));
    expect(pending).toMatchObject({ id: request.id, markupPercent: '16.375' });
    expect(pending).not.toHaveProperty('invite');
  });

  it.each([null, 1, 2])('notifies only the authorized reviewers when parent is %p', async parentId => {
    const { service, db, invite, request, notifications } = fixture(parentId);
    await service.submit(invite.token, person);
    const notice = expect.objectContaining({
      message: expect.stringContaining(person.username),
      actionLabel: 'Review application',
      actionUrl: '/dealers?registrationRequest=' + request.id,
      dedupeKey: 'dealer-registration:' + request.id + ':submitted:' + (parentId === null ? 'admin' : 'inviter'),
    });
    if (parentId === null) {
      expect(notifications.createAndSendToRoles).toHaveBeenCalledWith(['admin'], notice, { db });
      expect(notifications.createAndSend).not.toHaveBeenCalled();
    } else {
      expect(notifications.createAndSend).toHaveBeenCalledWith(notice, db);
      expect(notifications.createAndSend.mock.calls[0][0].recipientId).toBe(parentId);
      expect(notifications.createAndSendToRoles).not.toHaveBeenCalled();
    }
  });

  it.each([
    [null, actor(9, 'admin'), '-4.25', '-0.0425'], [1, actor(1), '35.125', '0.35125'], [2, actor(2), '0', '0'],
  ] as const)('creates the external account with the current invitation markup under parent %p', async (parentId, reviewer, currentPercent, expectedRatio) => {
    const { service, db, invite, request, welcome, notifications, rejections } = fixture(parentId);
    invite.markupPercent = new Prisma.Decimal(currentPercent);
    await service.review(reviewer, request.id, true);
    const [{ data }] = db.user.create.mock.calls[0];
    expect(data).toMatchObject({
      dealerMode: 'EXTERNAL', password: request.passwordHash, isTaxExempt: false,
      companyName: 'Example Glass', yearsOfExperience: 0,
    });
    expect(data.parentDealerId ?? null).toBe(parentId);
    expect(String(parentId === null ? data.markupOverride : data.networkMarkup)).toBe(expectedRatio);
    expect(String(data.networkTaxRate)).toBe('0.07');
    expect(data.paymentPlanId ?? null).toBeNull();
    expect(data.installationPriceProfileId ?? null).toBeNull();
    expect(String(data.estimatedMonthlySales)).toBe('2500.25');
    expect(applyDealerRegistrationConsent).toHaveBeenCalledWith(db, 80, request);
    expect(jest.mocked(applyDealerRegistrationConsent).mock.invocationCallOrder[0])
      .toBeLessThan(welcome.enqueue.mock.invocationCallOrder[0]);
    expect(welcome.enqueue).toHaveBeenCalledWith(80, db, true);
    expect(notifications.createAndSend).toHaveBeenCalledWith(expect.objectContaining({
      inAppOnly: true, recipientId: 80, message: expect.stringContaining('approved'),
      dedupeKey: 'dealer-registration:' + request.id + ':approved:applicant',
    }), db);
    expect(rejections.enqueue).not.toHaveBeenCalled();
    expect(db.dealerRegistrationRequest.delete).toHaveBeenCalledTimes(1);
  });

  it.each([
    [null, actor(4)], [1, actor(4)], [2, actor(1)], [2, actor(9, 'admin')],
  ] as const)('denies a reviewer outside the direct approval scope for parent %p', async (parentId, reviewer) => {
    const { service, db, request } = fixture(parentId);
    await expect(service.review(reviewer, request.id, true)).rejects.toThrow();
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.dealerRegistrationRequest.delete).not.toHaveBeenCalled();
  });

  it('rejects a request without creating an account or sending a welcome', async () => {
    const { service, db, request, welcome, notifications, rejections } = fixture(2);
    await service.review(actor(2), request.id, false);
    expect(db.dealerRegistrationRequest.delete).toHaveBeenCalledTimes(1);
    expect(db.user.create).not.toHaveBeenCalled();
    expect(welcome.enqueue).not.toHaveBeenCalled();
    expect(notifications.createAndSend).not.toHaveBeenCalled();
    expect(rejections.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      id: request.id, email: request.email, phone: request.phone,
    }), db);
    expect(rejections.enqueue.mock.invocationCallOrder[0])
      .toBeLessThan(db.dealerRegistrationRequest.delete.mock.invocationCallOrder[0]);
  });

  it('handles a second approval after the first review has consumed the request', async () => {
    const { service, db, request, welcome } = fixture(null);
    const admin = actor(9, 'admin');
    await service.review(admin, request.id, true);
    db.$queryRaw.mockImplementation(async (sql: TemplateStringsArray) =>
      sql.join('?').includes('FROM DealerRegistrationRequest') ? [] : [{ id: role.id }]);
    await expect(service.review(admin, request.id, true)).rejects.toThrow(NotFoundException);
    expect(db.user.create).toHaveBeenCalledTimes(1);
    expect(welcome.enqueue).toHaveBeenCalledTimes(1);
  });

  it('allows the reviewer to resolve a conflict with an account created while the application was pending', async () => {
    const { service, db, request, welcome } = fixture(1);
    db.user.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('Identity already in use', {
      code: 'P2002', clientVersion: 'test',
    }));
    await expect(service.review(actor(1), request.id, true)).rejects.toThrow(ConflictException);
    expect(db.dealerRegistrationRequest.delete).not.toHaveBeenCalled();
    expect(welcome.enqueue).not.toHaveBeenCalled();
    await service.review(actor(1), request.id, false);
    expect(db.dealerRegistrationRequest.delete).toHaveBeenCalledTimes(1);
  });
});
