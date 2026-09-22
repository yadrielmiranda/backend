import { isValidUsername } from './username-policy';

describe('username policy', () => {
  it.each([
    'carlos.perez',
    'SAGCO',
    'XtrongShield',
    'rh-impact',
    'user_2026',
    'Abc1',
    'A'.repeat(24),
  ])('accepts %s', (username) => {
    expect(isValidUsername(username)).toBe(true);
  });

  it.each([
    'abc',
    'A'.repeat(25),
    '1carlos',
    '_carlos',
    '.carlos',
    '-carlos',
    'RH Impact',
    'sales@company.com',
    'carlos__perez',
    'carlos..perez',
    'carlos.-perez',
    'carlos_',
    'carlos-',
    'carlos.',
    'a/bc',
    'a+bc',
  ])('rejects %s', (username) => {
    expect(isValidUsername(username)).toBe(false);
  });
});
