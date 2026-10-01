import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { ShareEstimateEmailDto } from '../dto/share-estimate-email.dto';
import { EstimateShareEmailService } from './estimate-share-email.service';

const request: ShareEstimateEmailDto = { to: ' customer@example.com ', pricingMode: 'detailed', includeContract: false };
const user = (id: number, role = 'dealer') => ({ id, role: { name: role } }) as AuthUser;

function fixture() {
  const people = [
    { id: 1, parentDealerId: null, dealerMode: 'INTERNAL', role: { name: 'dealer' }, isActive: true, deletedAt: null },
    { id: 2, parentDealerId: 1, dealerMode: 'INTERNAL', role: { name: 'dealer' }, isActive: true, deletedAt: null },
    { id: 3, parentDealerId: 2, dealerMode: 'INTERNAL', role: { name: 'dealer' }, isActive: true, deletedAt: null },
    { id: 4, parentDealerId: 2, dealerMode: 'INTERNAL', role: { name: 'dealer' }, isActive: true, deletedAt: null },
    { id: 8, parentDealerId: null, dealerMode: null, role: { name: 'admin' }, isActive: true, deletedAt: null },
    { id: 9, parentDealerId: null, dealerMode: null, role: { name: 'operator' }, isActive: true, deletedAt: null },
  ];
  const estimate = {
    id: 17, idUser: 3, number: 190017, name: 'Owner project',
    customerFirstName: 'Ada', customerLastName: 'Customer',
    user: people[2], publicToken: 'detailed-token', publicTotalToken: 'total_token', publicTokenEnabled: true,
  };
  const branding = { name: 'Subdealer brand', email: 'subdealer@example.com' };
  const agreement = {
    quoteFileKey: 'agreement.quote.pdf',
    snapshot: { ...estimate, name: 'Saved owner project', branding: { name: 'Saved owner brand', email: 'saved-owner@example.com' } },
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
    getOrCreatePublicLinkToken: jest.fn(async (_id, _actor, pricingMode) => ({
      token: pricingMode === 'total' ? 'total_token' : 'detailed-token', enabled: true,
    })),
  };
  const contracts = { prepare: jest.fn(async () => ({ current: { id: 'agreement-id', ready: true } })) };
  const email = { assertEstimateShareReady: jest.fn(), sendEstimateShare: jest.fn(async () => {}) };
  const service = new EstimateShareEmailService(prisma as any, publicShare as any, contracts as any, email as any);
  return { service, people, estimate, branding, agreement, prisma, publicShare, contracts, email };
}

describe('Direct estimate email', () => {
  it.each([1, 2, 3, 8])('allows eligible owner/ancestor/admin %s and uses owner details', async (id) => {
    const f = fixture();
    const actor = user(id, id === 8 ? 'admin' : 'dealer');
    await expect(f.service.send(17, request, actor)).resolves.toEqual({ sent: true });
    expect(f.publicShare.getOrCreatePublicLinkToken).toHaveBeenCalledWith(17, actor, 'detailed');
    expect(f.prisma.branding.findFirst).toHaveBeenCalledWith({
      where: { type: 'DEALER', userId: 3, isActive: true }, select: { name: true, email: true },
    });
    expect(f.email.sendEstimateShare).toHaveBeenCalledWith({
      to: 'customer@example.com', path: '/public/estimates/detailed-token', estimateNumber: 190017,
      ownerBrandingName: 'Subdealer brand', ownerEmail: 'subdealer@example.com', customerName: 'Ada Customer', projectName: 'Owner project',
    });
    expect(f.contracts.prepare).not.toHaveBeenCalled();
  });

  it.each(['detailed', 'total'] as const)('sends %s contract link only after preparing the owner agreement', async (pricingMode) => {
    const f = fixture();
    await f.service.send(17, { ...request, pricingMode, includeContract: true }, user(8, 'admin'));
    expect(f.contracts.prepare).toHaveBeenCalledWith(17, pricingMode, true, user(8, 'admin'));
    expect(f.prisma.estimateAgreement.findFirst).toHaveBeenCalledWith({
      where: { id: 'agreement-id', estimateId: 17, pricingMode, invalidatedAt: null },
      select: { snapshot: true, quoteFileKey: true },
    });
    expect(f.email.sendEstimateShare).toHaveBeenCalledWith(expect.objectContaining({
      path: `/public/estimates/${pricingMode === 'total' ? 'total_token' : 'detailed-token'}/agreements/agreement-id`,
      ownerBrandingName: 'Saved owner brand', ownerEmail: 'saved-owner@example.com', projectName: 'Saved owner project',
    }));
    expect(f.prisma.branding.findFirst).not.toHaveBeenCalled();
  });

  it('uses the current sender classification, not the owner classification', async () => {
    const f = fixture();
    f.people[2].dealerMode = 'EXTERNAL';
    await expect(f.service.send(17, request, user(1))).resolves.toEqual({ sent: true });
    await expect(f.service.send(17, request, user(3))).rejects.toThrow(ForbiddenException);
    expect(f.email.sendEstimateShare).toHaveBeenCalledTimes(1);
  });

  it.each(['operator', 'client', 'technician'])('rejects %s before preparing or emailing', async role => {
    const f = fixture();
    await expect(f.service.send(17, request, user(9, role))).rejects.toThrow(ForbiddenException);
    expect(f.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(f.publicShare.getOrCreatePublicLinkToken).not.toHaveBeenCalled();
    expect(f.email.sendEstimateShare).not.toHaveBeenCalled();
  });

  it('rejects sibling, unrelated account and child access to parent estimates', async () => {
    const f = fixture();
    for (const id of [4, 100]) {
      await expect(f.service.send(17, request, user(id))).rejects.toThrow();
    }
    f.estimate.idUser = 1;
    f.estimate.user = f.people[0];
    await expect(f.service.send(17, request, user(3))).rejects.toThrow(NotFoundException);
    expect(f.publicShare.getOrCreatePublicLinkToken).not.toHaveBeenCalled();
    expect(f.email.sendEstimateShare).not.toHaveBeenCalled();
  });

  it('rejects an external or inactive sender even if the browser exposes the button', async () => {
    const f = fixture();
    f.people[0].dealerMode = 'EXTERNAL';
    await expect(f.service.send(17, request, user(1))).rejects.toThrow(ForbiddenException);
    f.people[0].dealerMode = 'INTERNAL';
    f.people[0].isActive = false;
    await expect(f.service.send(17, request, user(1))).rejects.toThrow(ForbiddenException);
    expect(f.email.sendEstimateShare).not.toHaveBeenCalled();
  });

  it('does not reactivate disabled customer links or email an inactive owner', async () => {
    const f = fixture();
    f.estimate.publicTokenEnabled = false;
    await expect(f.service.send(17, request, user(8, 'admin'))).rejects.toThrow('disabled');
    f.estimate.publicTokenEnabled = true;
    f.estimate.user.isActive = false;
    await expect(f.service.send(17, request, user(8, 'admin'))).rejects.toThrow('inactive');
    expect(f.publicShare.getOrCreatePublicLinkToken).not.toHaveBeenCalled();
    expect(f.email.sendEstimateShare).not.toHaveBeenCalled();
  });

  it('does not prepare or send anything if mail configuration is unavailable', async () => {
    const f = fixture();
    f.email.assertEstimateShareReady.mockImplementation(() => { throw new Error('Email unavailable'); });
    await expect(f.service.send(17, request, user(1))).rejects.toThrow('Email unavailable');
    expect(f.publicShare.getOrCreatePublicLinkToken).not.toHaveBeenCalled();
    expect(f.contracts.prepare).not.toHaveBeenCalled();
    expect(f.email.sendEstimateShare).not.toHaveBeenCalled();
  });

  it('does not silently send without a requested but missing contract', async () => {
    const f = fixture();
    f.contracts.prepare.mockResolvedValue({ current: null });
    await expect(f.service.send(17, { ...request, includeContract: true }, user(1))).rejects.toThrow('owner must upload');
    expect(f.email.sendEstimateShare).not.toHaveBeenCalled();
    await f.service.send(17, request, user(1));
    expect(f.email.sendEstimateShare).toHaveBeenCalledTimes(1);
  });

  it('does not email failed, invalidated or unfinished agreement preparation', async () => {
    const f = fixture();
    f.contracts.prepare.mockRejectedValueOnce(new Error('PDF failed'));
    await expect(f.service.send(17, { ...request, includeContract: true }, user(1))).rejects.toThrow('PDF failed');
    f.prisma.estimateAgreement.findFirst.mockResolvedValueOnce(null);
    await expect(f.service.send(17, { ...request, includeContract: true }, user(1))).rejects.toThrow(ConflictException);
    f.agreement.quoteFileKey = null;
    await expect(f.service.send(17, { ...request, includeContract: true }, user(1))).rejects.toThrow(ConflictException);
    expect(f.email.sendEstimateShare).not.toHaveBeenCalled();
  });

  it('rejects simultaneous duplicate sends and allows explicit retry after mail failure', async () => {
    const f = fixture();
    let release: () => void;
    const started = new Promise<void>(resolve => {
      f.email.sendEstimateShare.mockImplementationOnce(() => { resolve(); return new Promise<void>(done => { release = done; }); });
    });
    const first = f.service.send(17, request, user(1));
    await started;
    await expect(f.service.send(17, request, user(1))).rejects.toThrow(ConflictException);
    expect(f.email.sendEstimateShare).toHaveBeenCalledTimes(1);
    release();
    await first;
    f.email.sendEstimateShare.mockRejectedValueOnce(new Error('SMTP failed'));
    await expect(f.service.send(17, request, user(1))).rejects.toThrow('SMTP failed');
    await expect(f.service.send(17, request, user(1))).resolves.toEqual({ sent: true });
    expect(f.email.sendEstimateShare).toHaveBeenCalledTimes(3);
  });

  it('does not send if token creation rejects the estimate state or returns a disabled token', async () => {
    const f = fixture();
    f.publicShare.getOrCreatePublicLinkToken.mockRejectedValueOnce(new BadRequestException('Estimate canceled'));
    await expect(f.service.send(17, request, user(1))).rejects.toThrow('Estimate canceled');
    f.publicShare.getOrCreatePublicLinkToken.mockResolvedValueOnce({ token: 'detailed-token', enabled: false });
    await expect(f.service.send(17, request, user(1))).rejects.toThrow('disabled');
    expect(f.email.sendEstimateShare).not.toHaveBeenCalled();
  });
});

describe('Estimate email request validation', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, transformOptions: { enableImplicitConversion: true } });
  const validate = (value: unknown) => pipe.transform(value, { type: 'body', metatype: ShareEstimateEmailDto });

  it('accepts a single recipient and preserves false without implicit string conversion', async () => {
    await expect(validate(request)).resolves.toMatchObject({ to: 'customer@example.com', pricingMode: 'detailed', includeContract: false });
  });
  it.each([
    { to: 'a@example.com,b@example.com' }, { to: 'invalid' }, { to: 'customer@example.com\r\nBcc: other@example.com' },
    { pricingMode: 'admin' }, { includeContract: 'false' }, { includeContract: 'true' }, { includeContract: 1 },
  ])('rejects invalid recipient, pricing mode or contract flag: %j', async change => {
    await expect(validate({ ...request, ...change })).rejects.toThrow(BadRequestException);
  });
});
