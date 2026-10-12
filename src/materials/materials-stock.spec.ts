import { materialAvailability, MaterialStockState, repackMaterial, withdrawMaterial } from './materials-stock';

const stock = (reservations: MaterialStockState['reservations'] = []): MaterialStockState => ({
  basePresentationId: 1,
  packs: [{ id: 1, baseUnits: 1, quantity: 0 }, { id: 2, baseUnits: 20, quantity: 3 }, { id: 3, baseUnits: 5, quantity: 0 }],
  reservations,
});

describe('Materials package availability', () => {
  it('makes closed boxes available online as individual tubes without opening them', () => {
    expect(materialAvailability(stock()).presentations).toContainEqual({ id: 1, quantity: 0, reservedQuantity: 0, availableQuantity: 60 });
  });
  it('automatically opens one box on actual withdrawal', () => {
    const result = withdrawMaterial(stock(), 1, 4);
    expect(result.packs.map(p => p.quantity)).toEqual([16, 2, 0]);
    expect(result.opened).toEqual([{ presentationId: 2, quantity: 1, baseUnits: 20 }]);
    expect(materialAvailability(result).totalBaseQuantity).toBe(56);
  });
  it('uses loose stock first and leaves closed boxes alone', () => {
    const state = stock(); state.packs[0].quantity = 7;
    expect(withdrawMaterial(state, 1, 4).packs.map(p => p.quantity)).toEqual([3, 3, 0]);
  });
  it('does not sell a full box whose contents are already reserved individually', () => {
    const state = stock([{ presentationId: 1, quantity: 41 }]);
    expect(materialAvailability(state).presentations.find(p => p.id === 2)?.availableQuantity).toBe(0);
    expect(() => withdrawMaterial(state, 2, 1)).toThrow('Insufficient');
  });
  it('protects exact package reservations while opening other boxes', () => {
    const result = withdrawMaterial(stock([{ presentationId: 2, quantity: 2 }]), 1, 4);
    expect(result.packs.map(p => p.quantity)).toEqual([16, 2, 0]);
    expect(() => withdrawMaterial(result, 1, 17)).toThrow('Insufficient');
  });
  it('allows other base reservations to move from loose stock into a remaining package', () => {
    const state = stock([{ presentationId: 1, quantity: 60 }]); state.packs[0].quantity = 4;
    expect(withdrawMaterial(state, 1, 4).packs.map(p => p.quantity)).toEqual([0, 3, 0]);
  });
  it('repacking preserves total stock and prevents using unavailable loose units', () => {
    const opened = repackMaterial(stock(), 2, 1, 'OPEN');
    const packed = repackMaterial(opened, 3, 4, 'PACK');
    expect(packed.packs.map(p => p.quantity)).toEqual([0, 2, 4]);
    expect(materialAvailability(packed).totalBaseQuantity).toBe(60);
    expect(() => repackMaterial(stock(), 3, 1, 'PACK')).toThrow('Invalid material stock');
  });
  it('cannot open boxes promised as whole boxes', () => {
    expect(() => repackMaterial(stock([{ presentationId: 2, quantity: 3 }]), 2, 1, 'OPEN')).toThrow('reserved');
  });
  it('does not modify the input on failure or success', () => {
    const state = stock(); const original = JSON.stringify(state);
    withdrawMaterial(state, 1, 44);
    expect(() => withdrawMaterial(state, 1, 61)).toThrow();
    expect(JSON.stringify(state)).toBe(original);
  });
});
