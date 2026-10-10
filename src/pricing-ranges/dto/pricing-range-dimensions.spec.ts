import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreatePricingRangeDto } from './create-pricing-range.dto';
import { UpdatePricingRangeDto } from './update-pricing-range.dto';

const dimensions = ['minWidthIn', 'maxWidthIn', 'minHeightIn', 'maxHeightIn'] as const;
const required = {
  idSystem: 1,
  idConfig: 1,
  code: 'RANGE_01',
  rules: [{ idCrystal: 1, costoA: '1', costoB: '2', costoC: '3' }],
};

describe.each([
  ['create', (values: object) => plainToInstance(CreatePricingRangeDto, { ...required, ...values })],
  ['update', (values: object) => plainToInstance(UpdatePricingRangeDto, values)],
] as const)('Pricing range %s dimensions', (_name, makeDto) => {
  it.each(dimensions)('preserves a four-decimal %s', field => {
    const dto = makeDto({ [field]: '67.0625' });
    expect(validateSync(dto)).toEqual([]);
    expect(dto[field]).toBe('67.0625');
  });

  it.each(dimensions)('preserves the seven-integer-digit capacity of %s', field => {
    expect(validateSync(makeDto({ [field]: '9999999.9999' }))).toEqual([]);
    expect(validateSync(makeDto({ [field]: '10000000' })).map(error => error.property)).toContain(field);
  });

  it.each(dimensions)('rejects excess precision in %s instead of rounding it', field => {
    const errors = validateSync(makeDto({ [field]: '67.06251' }));
    expect(errors.map(error => error.property)).toContain(field);
  });

  it('continues to allow omitted bounds and unbounded sides', () => {
    expect(validateSync(makeDto({}))).toEqual([]);
    expect(validateSync(makeDto(Object.fromEntries(dimensions.map(field => [field, null]))))).toEqual([]);
  });
});
