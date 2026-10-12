import { allocateMaterialSale } from './materials-sale-allocation';
import { MaterialStockState } from './materials-stock';
const stock = (boxes: number, bags: number, reservedUnits = 0): MaterialStockState => ({ basePresentationId: 1, packs: [{ id: 1, baseUnits: 1, quantity: 0 }, { id: 2, baseUnits: 20, quantity: boxes }, { id: 3, baseUnits: 5, quantity: bags }], reservations: reservedUnits ? [{ presentationId: 1, quantity: reservedUnits }] : [] });

describe('Material cart allocation across internal Stores', () => {
  it('preserves a scarce bag while taking the box from another Store', () => {
    const result = allocateMaterialSale([{ storeId: 1, stock: stock(1, 1, 5) }, { storeId: 2, stock: stock(1, 0) }], [{ presentationId: 2, quantity: 1 }, { presentationId: 3, quantity: 1 }]);
    expect(result).toEqual(expect.arrayContaining([{ storeId: 1, presentationId: 3, quantity: 1 }, { storeId: 2, presentationId: 2, quantity: 1 }]));
  });
  it('can split requested units contained in closed boxes across Stores', () => {
    expect(allocateMaterialSale([{ storeId: 1, stock: stock(1, 0) }, { storeId: 2, stock: stock(1, 0) }], [{ presentationId: 1, quantity: 30 }])).toEqual([{ storeId: 1, presentationId: 1, quantity: 20 }, { storeId: 2, presentationId: 1, quantity: 10 }]);
  });
  it('rejects individually advertised quantities that cannot coexist in the same cart', () => {
    expect(() => allocateMaterialSale([{ storeId: 1, stock: stock(1, 1, 5) }], [{ presentationId: 2, quantity: 1 }, { presentationId: 3, quantity: 1 }])).toThrow('no longer available');
  });
  it('does not alter physical stock or another sale reservation during allocation', () => {
    const locations = [{ storeId: 1, stock: stock(2, 1, 4) }];
    const before = JSON.stringify(locations);
    allocateMaterialSale(locations, [{ presentationId: 2, quantity: 1 }, { presentationId: 1, quantity: 3 }]);
    expect(JSON.stringify(locations)).toBe(before);
  });
  it('matches exhaustive feasible assignments for small mixed carts', () => {
    let seed = 73;
    const random = (max: number) => { seed = (seed * 48271) % 2147483647; return seed % max; };
    for (let example = 0; example < 200; example++) {
      const boxA = random(3), bagA = random(4), boxB = random(3), bagB = random(4);
      const reservedA = random(boxA * 20 + bagA * 5 + 1), reservedB = random(boxB * 20 + bagB * 5 + 1);
      const boxes = random(4) + 1, bags = random(5) + 1, units = random(10) + 1;
      const capA = boxA * 20 + bagA * 5 - reservedA, capB = boxB * 20 + bagB * 5 - reservedB;
      let feasible = false;
      for (let aBox = 0; aBox <= boxes; aBox++) for (let aBag = 0; aBag <= bags; aBag++) {
        const bBox = boxes - aBox, bBag = bags - aBag;
        const leftA = capA - aBox * 20 - aBag * 5, leftB = capB - bBox * 20 - bBag * 5;
        if (aBox <= boxA && aBag <= bagA && bBox <= boxB && bBag <= bagB && leftA >= 0 && leftB >= 0 && leftA + leftB >= units) feasible = true;
      }
      const run = () => allocateMaterialSale([{ storeId: 1, stock: stock(boxA, bagA, reservedA) }, { storeId: 2, stock: stock(boxB, bagB, reservedB) }], [{ presentationId: 2, quantity: boxes }, { presentationId: 3, quantity: bags }, { presentationId: 1, quantity: units }]);
      if (feasible) expect(run).not.toThrow(); else expect(run).toThrow();
    }
  });
});
