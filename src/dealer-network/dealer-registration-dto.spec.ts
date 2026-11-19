import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { SubmitDealerRegistrationDto } from './dealer-network.dto';

const form = {
  username: 'dealer.test', password: 'example-password', firstName: 'Test', lastName: 'Installer',
  phone: '+13055551234', email: 'dealer@example.test',
  street: '100 Example St', city: 'Miami', state: 'FL', postalCode: '33101',
  yearsOfExperience: 0, preferredLanguage: 'Spanish',
};

const pipe = new ValidationPipe({
  transform: true, whitelist: true, transformOptions: { enableImplicitConversion: true },
});

function submit(overrides: Record<string, unknown> = {}): Promise<SubmitDealerRegistrationDto> {
  return pipe.transform({ ...form, ...overrides }, { type: 'body', metatype: SubmitDealerRegistrationDto });
}

describe('Public dealer registration fields', () => {
  it.each(['English', 'Spanish'])('accepts %s and zero years of experience without company or sales', async (language) => {
    const result = await submit({ preferredLanguage: language });
    expect(result).toMatchObject({ preferredLanguage: language, yearsOfExperience: 0 });
    expect(result.companyName).toBeUndefined();
    expect(result.estimatedMonthlySales).toBeUndefined();
  });

  it.each([undefined, null, '', ' ', -1, 1.5, false])('rejects invalid years of experience (%p)', async (years) => {
    await expect(submit({ yearsOfExperience: years })).rejects.toThrow(BadRequestException);
  });

  it.each([undefined, '', 'Español'])('requires one of the displayed language choices (%p)', async (language) => {
    await expect(submit({ preferredLanguage: language })).rejects.toThrow(BadRequestException);
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
