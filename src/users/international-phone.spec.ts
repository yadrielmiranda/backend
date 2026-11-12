import { ValidationPipe } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { RegisterUserDto } from '@/auth/dto/register-user.dto';
import { UpdateProfileDto } from '@/auth/dto/update-profile.dto';
import { CreateNetworkMemberDto } from '@/dealer-network/dealer-network.dto';
import { CreateEstimateHeaderDto } from '@/estimates/dto/estimate-header.dto';

const pipe = new ValidationPipe({
  transform: true, whitelist: true,
  transformOptions: { enableImplicitConversion: true },
});
const personal = {
  username: 'international-phone', firstName: 'Test', lastName: 'Contact',
  email: 'phone@example.test', password: 'Example-password-123',
  street: '100 Main Street', city: 'Miami', state: 'FL', postalCode: '33101',
  idRole: 2, markupPercent: 10,
};
const validate = (metatype: any, payload: unknown) => pipe.transform(payload, { type: 'body', metatype });

describe('International account and estimate contact phones', () => {
  it.each([
    ['US local', '(305) 555-1234', '+13055551234'],
    ['US international', '+1 (305) 555-1234', '+13055551234'],
    ['Canada', '+1 416 555 1234', '+14165551234'],
    ['Cuba', '+53 5 123 4567', '+5351234567'],
    ['Spain', '+34 612 345 678', '+34612345678'],
    ['Mexico', '+52 55 1234 5678', '+525512345678'],
    ['United Kingdom', '+44 20 7946 0958', '+442079460958'],
  ])('normalizes %s consistently in registration, admin, dealer, profile and estimate forms', async (_country, phone, expected) => {
    for (const dto of [CreateUserDto, RegisterUserDto, CreateNetworkMemberDto, UpdateUserDto, UpdateProfileDto]) {
      expect((await validate(dto, { ...personal, phone })).phone).toBe(expected);
    }
    expect((await validate(CreateEstimateHeaderDto, { name: 'Phone example', customerPhone: phone })).customerPhone).toBe(expected);
  });

  it.each([
    '+34123456789', '+999123456789', '+1305555123',
    'Call +13055551234', '+13055551234 tomorrow',
    '+13055551234 ext 9', '+13055551234 x9', 'tel:+13055551234;ext=9',
    '+13055551234, +34612345678', '+13055551234\n+34612345678',
    13055551234, false, ['+13055551234'], { number: '+13055551234' },
  ])('rejects malformed, invalid or non-text phone values: %j', async phone => {
    await expect(validate(RegisterUserDto, { ...personal, phone })).rejects.toThrow();
    await expect(validate(UpdateProfileDto, { phone })).rejects.toThrow();
    await expect(validate(CreateEstimateHeaderDto, { name: 'Phone example', customerPhone: phone })).rejects.toThrow();
  });

  it('preserves required account phones and optional estimate/update phones', async () => {
    for (const phone of [undefined, null, '']) {
      await expect(validate(CreateUserDto, { ...personal, phone })).rejects.toThrow();
    }
    expect(await validate(UpdateProfileDto, { firstName: 'Changed' })).not.toHaveProperty('phone');
    expect((await validate(UpdateProfileDto, { phone: null })).phone).toBeNull();
    expect((await validate(CreateEstimateHeaderDto, { name: 'No phone' })).customerPhone).toBeUndefined();
    expect((await validate(CreateEstimateHeaderDto, { name: 'No phone', customerPhone: '  ' })).customerPhone).toBeNull();
  });
});
