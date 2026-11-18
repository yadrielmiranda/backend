import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { EstimateShareEmailRejectedException, type EstimateShareEmailResult } from '@/notifications/notification-email.service';
import { ShareEstimateMessageDto } from '../dto/share-estimate-message.dto';
import { EstimateShareEmailService } from './estimate-share-email.service';
import type { EstimateShareSmsResult } from './estimate-share-sms.service';

const actor = (id = 8, role = 'admin') => ({ id, role: { name: role } }) as AuthUser;
const request: ShareEstimateMessageDto = {
  channel: 'both', to: ' Customer@Example.com ', phone: '(305) 555-0100',
  pricingMode: 'detailed', includeContract: false,
};

function fixture() {
  const people = [
    { id: 1, parentDealerId: null, dealerMode: 'INTERNAL', role: { name: 'dealer' }, isActive: true, deletedAt: null as Date | null },
    { id: 2, parentDealerId: 1, dealerMode: 'INTERNAL', role: { name: 'dealer' }, isActive: true, deletedAt: null as Date | null },
    { id: 3, parentDealerId: 2, dealerMode: 'INTERNAL', role: { name: 'dealer' }, isActive: true, deletedAt: null as Date | null },
    { id: 4, parentDealerId: 2, dealerMode: 'INTERNAL', role: { name: 'dealer' }, isActive: true, deletedAt: null as Date | null },
    { id: 8, parentDealerId: null, dealerMode: null, role: { name: 'admin' }, isActive: true, deletedAt: null as Date | null },
    { id: 9, parentDealerId: null, dealerMode: null, role: { name: 'operator' }, isActive: true, deletedAt: null as Date | null },
  ];
  const estimate = {
    id: 17, idUser: 3, number: 190017, name: 'Owner project',
    customerFirstName: 'Ada', customerLastName: 'Customer', user: people[2],
    publicToken: 'detailed-token', publicTotalToken: 'total_token', publicTokenEnabled: true,
  };
  const branding = { name: 'Owner brand', email: 'owner@example.com' };
  const agreement = {
    quoteFileKey: 'agreement.quote.pdf',
    snapshot: { ...estimate, name: 'Saved project', branding: { name: 'Saved owner brand', email: 'saved@example.com' } },
  };
  const prisma = {
    user: { findUnique: jest.fn(async ({ where }) => {
      const found = people.find(person => person.id === where.id);
      return found && { ...found, parentDealer: people.find(person => person.id === found.parentDealerId) ?? null };
    }) },
    estimate: { findUnique: jest.fn(async () => estimate) },
    estimateAgreement: { findFirst: jest.fn(async () => agreement) },
    branding: { findFirst: jest.fn(async () => branding) },
  };
  const publicShare = {
    getOrCreatePublicLinkToken: jest.fn(async (_id: number, _actor: AuthUser, pricingMode: string) => ({
      token: pricingMode === 'total' ? 'total_token' : 'detailed-token', enabled: true,
    })),
  };
  const contracts = { prepare: jest.fn(async () => ({ current: { id: 'agreement-id', ready: true } })) };
  const email = {
    assertEstimateShareReady: jest.fn(),
    sendEstimateShare: jest.fn(async (_input: unknown): Promise<EstimateShareEmailResult> => ({ sent: true })),
  };
  const sms = {
    assertReady: jest.fn(async (phone: string) => phone),
    send: jest.fn(async (_input: unknown): Promise<EstimateShareSmsResult> => ({ status: 'sent' })),
  };
  const service = new EstimateShareEmailService(prisma as any, publicShare as any, contracts as any, email as any, sms as any);
  return { service, people, estimate, agreement, prisma, publicShare, contracts, email, sms };
}

function expectNoDispatch(f: ReturnType<typeof fixture>) {
  expect(f.email.sendEstimateShare).not.toHaveBeenCalled();
  expect(f.sms.send).not.toHaveBeenCalled();
}

describe('Explicit estimate sharing by email and SMS', () => {
  it('sends email alone, normalizes To/CC, and never requires a phone or SMS configuration', async () => {
    const f = fixture();
    f.sms.assertReady.mockRejectedValue(new ServiceUnavailableException());
    await expect(f.service.sendMessage(17, {
      ...request, channel: 'email', phone: undefined,
      cc: ' Customer@Example.com, COPY@EXAMPLE.COM, copy@example.com ',
    }, actor())).resolves.toEqual({ sent: true, email: { status: 'sent' } });
    expect(f.email.sendEstimateShare).toHaveBeenCalledWith(expect.objectContaining({
      to: 'customer@example.com', cc: 'copy@example.com', path: '/public/estimates/detailed-token',
    }));
    expect(f.sms.assertReady).not.toHaveBeenCalled();
    expect(f.sms.send).not.toHaveBeenCalled();
  });

  it('sends SMS alone to an explicit guest phone without email configuration or a recipient account lookup', async () => {
    const f = fixture();
    f.email.assertEstimateShareReady.mockImplementation(() => { throw new ServiceUnavailableException(); });
    await expect(f.service.sendMessage(17, { ...request, channel: 'sms', to: undefined }, actor()))
      .resolves.toEqual({ sent: true, sms: { status: 'sent' } });
    expect(f.sms.assertReady).toHaveBeenCalledWith('+13055550100');
    expect(f.sms.send).toHaveBeenCalledWith({
      phone: '+13055550100', path: '/public/estimates/detailed-token', estimateNumber: 190017,
      customerName: 'Ada Customer', ownerBrandingName: 'Owner brand',
    });
    expect(f.email.assertEstimateShareReady).not.toHaveBeenCalled();
    expect(f.email.sendEstimateShare).not.toHaveBeenCalled();
    expect(f.prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(f.prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 8 } }));
  });

  it.each(['detailed', 'total'] as const)('uses one prepared %s contract and exactly the same customer path for both channels', async pricingMode => {
    const f = fixture();
    await expect(f.service.sendMessage(17, { ...request, pricingMode, includeContract: true }, actor()))
      .resolves.toEqual({ sent: true, email: { status: 'sent' }, sms: { status: 'sent' } });
    const path = `/public/estimates/${pricingMode === 'total' ? 'total_token' : 'detailed-token'}/agreements/agreement-id`;
    expect(f.publicShare.getOrCreatePublicLinkToken).toHaveBeenCalledTimes(1);
    expect(f.publicShare.getOrCreatePublicLinkToken).toHaveBeenCalledWith(17, actor(), pricingMode);
    expect(f.contracts.prepare).toHaveBeenCalledTimes(1);
    expect(f.contracts.prepare).toHaveBeenCalledWith(17, pricingMode, true, actor());
    expect(f.prisma.estimateAgreement.findFirst).toHaveBeenCalledWith({
      where: { id: 'agreement-id', estimateId: 17, pricingMode, invalidatedAt: null },
      select: { snapshot: true, quoteFileKey: true },
    });
    expect(f.email.sendEstimateShare).toHaveBeenCalledWith(expect.objectContaining({ path, ownerBrandingName: 'Saved owner brand' }));
    expect(f.sms.send).toHaveBeenCalledWith(expect.objectContaining({ path, ownerBrandingName: 'Saved owner brand' }));
    expect(f.email.sendEstimateShare).toHaveBeenCalledTimes(1);
    expect(f.sms.send).toHaveBeenCalledTimes(1);
  });

  it('uses the total report token without preparing a contract when it was not selected', async () => {
    const f = fixture();
    await f.service.sendMessage(17, { ...request, pricingMode: 'total' }, actor());
    expect(f.email.sendEstimateShare).toHaveBeenCalledWith(expect.objectContaining({ path: '/public/estimates/total_token' }));
    expect(f.sms.send).toHaveBeenCalledWith(expect.objectContaining({ path: '/public/estimates/total_token' }));
    expect(f.contracts.prepare).not.toHaveBeenCalled();
  });

  it.each(['email', 'sms'] as const)('preflights %s before preparing links and sends neither selected channel if unavailable', async channel => {
    const f = fixture();
    const error = new ServiceUnavailableException('Unavailable in this environment.');
    if (channel === 'email') f.email.assertEstimateShareReady.mockImplementation(() => { throw error; });
    else f.sms.assertReady.mockRejectedValue(error);
    await expect(f.service.sendMessage(17, { ...request, includeContract: true }, actor())).rejects.toMatchObject({
      response: { code: 'ESTIMATE_SHARE_NOT_SENT', message: 'Unavailable in this environment.' },
    });
    expect(f.publicShare.getOrCreatePublicLinkToken).not.toHaveBeenCalled();
    expect(f.contracts.prepare).not.toHaveBeenCalled();
    expectNoDispatch(f);
  });

  it.each([1, 2, 3, 8])('allows the current owner, ancestor dealer, or administrator %s', async id => {
    const f = fixture();
    await expect(f.service.sendMessage(17, request, actor(id, id === 8 ? 'admin' : 'dealer')))
      .resolves.toMatchObject({ sent: true });
  });

  it.each(['operator', 'technician', 'client'])('rejects the %s role before preparing or dispatching', async role => {
    const f = fixture();
    await expect(f.service.sendMessage(17, request, actor(9, role))).rejects.toThrow(ForbiddenException);
    expect(f.publicShare.getOrCreatePublicLinkToken).not.toHaveBeenCalled();
    expectNoDispatch(f);
  });

  it('rejects sibling/unrelated dealers and a child dealer accessing its parent estimate', async () => {
    const f = fixture();
    for (const id of [4, 100]) {
      await expect(f.service.sendMessage(17, request, actor(id, 'dealer'))).rejects.toThrow();
    }
    f.estimate.idUser = 1;
    f.estimate.user = f.people[0];
    await expect(f.service.sendMessage(17, request, actor(3, 'dealer'))).rejects.toThrow(NotFoundException);
    expect(f.publicShare.getOrCreatePublicLinkToken).not.toHaveBeenCalled();
    expectNoDispatch(f);
  });

  it.each(['external', 'inactive', 'deleted', 'changed-role'] as const)('uses current account permissions and rejects an %s sender', async condition => {
    const f = fixture();
    if (condition === 'external') f.people[0].dealerMode = 'EXTERNAL';
    if (condition === 'inactive') f.people[0].isActive = false;
    if (condition === 'deleted') f.people[0].deletedAt = new Date();
    if (condition === 'changed-role') f.people[0].role.name = 'client';
    await expect(f.service.sendMessage(17, request, actor(1, 'dealer'))).rejects.toThrow(ForbiddenException);
    expect(f.publicShare.getOrCreatePublicLinkToken).not.toHaveBeenCalled();
    expectNoDispatch(f);
  });

  it.each(['inactive-owner', 'disabled-link', 'canceled-estimate', 'missing-contract', 'invalidated-contract'] as const)(
    'prevents every selected channel from sending for %s', async condition => {
      const f = fixture();
      if (condition === 'inactive-owner') f.estimate.user.isActive = false;
      if (condition === 'disabled-link') f.estimate.publicTokenEnabled = false;
      if (condition === 'canceled-estimate') f.publicShare.getOrCreatePublicLinkToken.mockRejectedValue(new BadRequestException('Estimate is canceled.'));
      if (condition === 'missing-contract') f.contracts.prepare.mockResolvedValue({ current: null } as any);
      if (condition === 'invalidated-contract') f.prisma.estimateAgreement.findFirst.mockResolvedValue(null as any);
      await expect(f.service.sendMessage(17, { ...request, includeContract: true }, actor())).rejects.toThrow();
      expectNoDispatch(f);
    },
  );

  it('keeps SMS independent when email acceptance is unknown, without retrying either channel', async () => {
    const f = fixture();
    f.email.sendEstimateShare.mockRejectedValue(new Error('Connection lost after SMTP write.'));
    await expect(f.service.sendMessage(17, request, actor())).resolves.toEqual({
      sent: false, email: { status: 'unknown', message: expect.any(String) }, sms: { status: 'sent' },
    });
    expect(f.email.sendEstimateShare).toHaveBeenCalledTimes(1);
    expect(f.sms.send).toHaveBeenCalledTimes(1);
  });

  it('preserves per-recipient partial email outcomes alongside successful SMS without resending', async () => {
    const f = fixture();
    f.email.sendEstimateShare.mockResolvedValue({
      sent: false, accepted: ['customer@example.com'], rejected: ['copy@example.com'], unconfirmed: [],
    });
    await expect(f.service.sendMessage(17, { ...request, cc: 'copy@example.com' }, actor())).resolves.toEqual({
      sent: false,
      email: { status: 'partial', accepted: ['customer@example.com'], rejected: ['copy@example.com'], unconfirmed: [] },
      sms: { status: 'sent' },
    });
    expect(f.email.sendEstimateShare).toHaveBeenCalledTimes(1);
    expect(f.sms.send).toHaveBeenCalledTimes(1);
  });

  it.each(['failed', 'unknown'] as const)('preserves SMS %s after email succeeds and does not send again automatically', async status => {
    const f = fixture();
    f.sms.send.mockResolvedValue({ status, message: 'SMS was not confirmed.' });
    await expect(f.service.sendMessage(17, request, actor())).resolves.toEqual({
      sent: false, email: { status: 'sent' }, sms: { status, message: 'SMS was not confirmed.' },
    });
    expect(f.email.sendEstimateShare).toHaveBeenCalledTimes(1);
    expect(f.sms.send).toHaveBeenCalledTimes(1);
  });

  it('allows correcting a definite email rejection while preserving the accepted SMS', async () => {
    const f = fixture();
    f.email.sendEstimateShare.mockRejectedValue(new EstimateShareEmailRejectedException());
    await expect(f.service.sendMessage(17, request, actor())).resolves.toEqual({
      sent: false, email: { status: 'failed', message: expect.stringContaining('rejected') }, sms: { status: 'sent' },
    });
    expect(f.email.sendEstimateShare).toHaveBeenCalledTimes(1);
    expect(f.sms.send).toHaveBeenCalledTimes(1);
  });

  it('reports a late SMS readiness block as failed while preserving the accepted email', async () => {
    const f = fixture();
    f.sms.send.mockRejectedValue(new ConflictException('This number has stopped SMS messages.'));
    await expect(f.service.sendMessage(17, request, actor())).resolves.toEqual({
      sent: false, email: { status: 'sent' }, sms: { status: 'failed', message: 'This number has stopped SMS messages.' },
    });
    expect(f.sms.send).toHaveBeenCalledTimes(1);
    expect(f.email.sendEstimateShare).toHaveBeenCalledTimes(1);
  });

  it('returns unknown if the SMS transport throws while preserving the accepted email', async () => {
    const f = fixture();
    f.sms.send.mockRejectedValue(new Error('Timeout.'));
    await expect(f.service.sendMessage(17, request, actor())).resolves.toEqual({
      sent: false, email: { status: 'sent' }, sms: { status: 'unknown', message: expect.any(String) },
    });
    expect(f.sms.send).toHaveBeenCalledTimes(1);
    expect(f.email.sendEstimateShare).toHaveBeenCalledTimes(1);
  });

  it.each(['legacy-first', 'message-first'] as const)('shares its concurrent-send lock with the legacy endpoint (%s)', async ordering => {
    const f = fixture();
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const preparing = new Promise<void>(resolve => { started = resolve; });
    f.publicShare.getOrCreatePublicLinkToken.mockImplementationOnce(async () => {
      started();
      await blocked;
      return { token: 'detailed-token', enabled: true };
    });
    const legacy = () => f.service.send(17, { to: 'customer@example.com', pricingMode: 'detailed', includeContract: false }, actor());
    const message = () => f.service.sendMessage(17, request, actor());
    const pending = ordering === 'legacy-first' ? legacy() : message();
    await preparing;
    try {
      await expect(ordering === 'legacy-first' ? message() : legacy()).rejects.toThrow(ConflictException);
      expect(f.publicShare.getOrCreatePublicLinkToken).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await pending;
    }
    expect(f.email.sendEstimateShare).toHaveBeenCalledTimes(1);
    expect(f.sms.send).toHaveBeenCalledTimes(ordering === 'message-first' ? 1 : 0);
    // A later explicit attempt is allowed once the active send has finished.
    await legacy();
    expect(f.email.sendEstimateShare).toHaveBeenCalledTimes(2);
  });
});

describe('Estimate sharing request validation', () => {
  const pipe = new ValidationPipe({
    transform: true, whitelist: true, forbidNonWhitelisted: false,
    transformOptions: { enableImplicitConversion: true },
  });
  const validate = (value: unknown) => pipe.transform(value, { type: 'body', metatype: ShareEstimateMessageDto });

  it.each([
    { channel: 'email', to: ' CUSTOMER@EXAMPLE.COM ', pricingMode: 'detailed', includeContract: false },
    { channel: 'sms', phone: '(305) 555-0100', pricingMode: 'total', includeContract: true },
    { ...request, cc: 'COPY@example.com, copy@example.com' },
  ])('accepts the fields for the selected channel and normalizes recipients: %j', async value => {
    const result = await validate(value);
    expect(result.channel).toBe(value.channel);
    expect(result.includeContract).toBe(value.includeContract);
    if (value.channel !== 'sms') expect(result.to).toBe('customer@example.com');
    if (value.channel !== 'email') expect(result.phone).toBe('+13055550100');
  });

  it.each([
    { channel: undefined }, { channel: 'push' }, { channel: ['sms'] }, { channel: 1 },
    { phone: undefined }, { phone: '' }, { phone: 'invalid' }, { phone: 3055550100 }, { phone: ['3055550100'] },
    { to: undefined }, { to: '' }, { to: 'invalid' }, { to: ['customer@example.com'] }, { cc: 'invalid' },
    { pricingMode: 'admin' }, { pricingMode: undefined }, { pricingMode: ['detailed'] },
    { includeContract: undefined }, { includeContract: 'false' }, { includeContract: 'true' }, { includeContract: 1 },
  ])('rejects invalid selected-channel input without implicit coercion: %j', async change => {
    await expect(validate({ ...request, ...change })).rejects.toThrow(BadRequestException);
  });

  it('rejects an SMS-only request with no phone and an email-only request with no To', async () => {
    await expect(validate({ ...request, channel: 'sms', to: undefined, phone: undefined })).rejects.toThrow(BadRequestException);
    await expect(validate({ ...request, channel: 'email', to: undefined, phone: undefined })).rejects.toThrow(BadRequestException);
  });

  it.each([
    { channel: 'email', phone: undefined }, { channel: 'sms', to: undefined, cc: undefined },
  ])('does not require recipients for an unselected channel: %j', async change => {
    await expect(validate({ ...request, ...change })).resolves.toBeInstanceOf(ShareEstimateMessageDto);
  });
});
