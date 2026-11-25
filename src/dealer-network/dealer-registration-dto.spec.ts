import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { SubmitDealerRegistrationDto } from './dealer-network.dto';

const form = {
  username: 'dealer.test', password: 'example-password', firstName: 'Test', lastName: 'Installer',
  phone: '+13055551234', email: 'dealer@example.test',
  street: '100 Example St', city: 'Miami', state: 'FL', postalCode: '33101',
  yearsOfExperience: 0,
};

const pipe = new ValidationPipe({
  transform: true, whitelist: true, transformOptions: { enableImplicitConversion: true },
});

function submit(overrides: Record<string, unknown> = {}): Promise<SubmitDealerRegistrationDto> {
  return pipe.transform({ ...form, ...overrides }, { type: 'body', metatype: SubmitDealerRegistrationDto });
}

describe('Public dealer registration fields', () => {
  it('accepts zero years of experience without company or sales', async () => {
    const result = await submit();
    expect(result.yearsOfExperience).toBe(0);
    expect(result.companyName).toBeUndefined();
    expect(result.estimatedMonthlySales).toBeUndefined();
  });

  it('allows omitting the username but validates a customized username', async () => {
    expect((await submit({ username: undefined })).username).toBeUndefined();
    expect((await submit({ username: 'custom.dealer' })).username).toBe('custom.dealer');
    for (const username of ['', null, 'no', 'not an account']) {
      await expect(submit({ username })).rejects.toThrow(BadRequestException);
    }
  });

  it.each(['street', 'city', 'state', 'postalCode'])('still requires %s on a dealer application', async field => {
    await expect(submit({ [field]: undefined })).rejects.toThrow(BadRequestException);
  });

  it.each([undefined, null, '', ' ', -1, 1.5, false])('rejects invalid years of experience (%p)', async (years) => {
    await expect(submit({ yearsOfExperience: years })).rejects.toThrow(BadRequestException);
  });

  it('discards the obsolete language preference from older forms', async () => {
    expect(await submit({ preferredLanguage: 'Spanish' })).not.toHaveProperty('preferredLanguage');
  });

  it('accepts USD with cents and retains an explicit zero', async () => {
    expect(Number((await submit({ estimatedMonthlySales: 1500.25 })).estimatedMonthlySales)).toBe(1500.25);
    expect(Number((await submit({ estimatedMonthlySales: 0 })).estimatedMonthlySales)).toBe(0);
    await expect(submit({ estimatedMonthlySales: 10.123 })).rejects.toThrow(BadRequestException);
    await expect(submit({ estimatedMonthlySales: -1 })).rejects.toThrow(BadRequestException);
  });

  it('keeps role, parent, pricing, and approval under server control', async () => {
    const privilegedFields = {
      parentDealerId: 77, idRole: 1, dealerMode: 'INTERNAL', markupPercent: 90, taxPercent: 0,
      installationPriceProfileId: 2, paymentPlanId: 2, isTaxExempt: true, status: 'APPROVED',
    };
    const result = await submit(privilegedFields);
    for (const field of Object.keys(privilegedFields)) expect(result).not.toHaveProperty(field);
  });
});
