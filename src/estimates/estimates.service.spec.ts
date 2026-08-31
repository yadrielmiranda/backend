import { BrandingType } from '@prisma/client';
import { EstimatesService } from './estimates.service';

describe('EstimatesService', () => {
  function buildService(prisma: unknown) {
    return new EstimatesService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  }

  it('falls back to Company branding when a dealer has no branding', async () => {
    const companyBranding = { id: 1, name: 'Authentic Evolution' };
    const prisma = {
      branding: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(companyBranding),
      },
    };
    const service = buildService(prisma);

    const branding = await (service as any).resolveBrandingForEstimate({
      idUser: 44,
      user: { role: { name: 'dealer' } },
    });

    expect(branding).toBe(companyBranding);
    expect(prisma.branding.findFirst).toHaveBeenNthCalledWith(1, {
      where: {
        type: BrandingType.DEALER,
        userId: 44,
        isActive: true,
      },
    });
    expect(prisma.branding.findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        type: BrandingType.COMPANY,
        isActive: true,
      },
    });
  });

  it('keeps the dealer branding when it exists', async () => {
    const dealerBranding = { id: 2, name: 'Dealer Windows' };
    const prisma = {
      branding: {
        findFirst: jest.fn().mockResolvedValue(dealerBranding),
      },
    };
    const service = buildService(prisma);

    const branding = await (service as any).resolveBrandingForEstimate({
      idUser: 44,
      user: { role: { name: 'dealer' } },
    });

    expect(branding).toBe(dealerBranding);
    expect(prisma.branding.findFirst).toHaveBeenCalledTimes(1);
  });
});
