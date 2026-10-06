import { resolvePatternInput } from './pattern-input';
import { MuntinPatternsService } from './muntin-patterns.service';

describe('muntin pattern input metadata', () => {
  it('maps legacy Full View and grid flags without conflating presets', () => {
    expect(resolvePatternInput({ requiresLites: false })).toEqual({ inputMode: 'NONE', requiresLites: false, requiresType: false });
    expect(resolvePatternInput({ requiresLites: true })).toEqual({ inputMode: 'GRID', requiresLites: true, requiresType: true });
    expect(resolvePatternInput({ inputMode: 'PRESET', requiresType: true })).toEqual({ inputMode: 'PRESET', requiresLites: false, requiresType: true });
    expect(resolvePatternInput({ inputMode: 'GRID', requiresType: false })).toEqual({ inputMode: 'GRID', requiresLites: true, requiresType: false });
  });
  it.each([
    { inputMode: 'NONE', requiresType: true }, { inputMode: 'PRESET', requiresLites: true },
    { inputMode: 'GRID', requiresLites: false }, { inputMode: 'UNKNOWN' },
  ])('rejects conflicting metadata %j', data => {
    expect(() => resolvePatternInput(data as any)).toThrow();
  });
  it('keeps preset metadata when only the catalog name is edited', async () => {
    const current = { inputMode: 'PRESET', requiresLites: false, requiresType: true };
    const tx = { muntinPattern: {
      findUnique: jest.fn(async () => current), update: jest.fn(async ({ data }) => data),
    } };
    const service = new MuntinPatternsService({ $transaction: async work => work(tx) } as any);
    await expect(service.updateMuntinPattern({ where: { id: 3 }, data: { name: '8L' } }))
      .resolves.toEqual({ ...current, name: '8L' });
  });
  it('derives requiresLites when creating a preset without touching saved piece data', async () => {
    const tx = { muntinPattern: { create: jest.fn(async ({ data }) => data) } };
    const service = new MuntinPatternsService({ $transaction: async work => work(tx) } as any);
    await expect(service.createMuntinPattern({ name: '8L', inputMode: 'PRESET', requiresType: true }))
      .resolves.toMatchObject({ inputMode: 'PRESET', requiresLites: false, requiresType: true });
  });
});
