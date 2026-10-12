import { materialAvailability, MaterialStockError, MaterialStockState } from './materials-stock';

type Location = { storeId: number; stock: MaterialStockState };
type Request = { presentationId: number; quantity: number };
type Allocation = Request & { storeId: number };

/** Allocate whole presentations first without consuming capacity needed by scarcer packages elsewhere. */
export function allocateMaterialSale(locations: Location[], requested: Request[]): Allocation[] {
  if (!locations.length) throw new MaterialStockError('No material inventory locations are available.');
  const availability = locations.map(l => materialAvailability(l.stock));
  const remainingCapacity = availability.map(a => a.availableBaseQuantity);
  const baseId = locations[0].stock.basePresentationId;
  const base = requested.find(r => r.presentationId === baseId);
  const packages = requested.filter(r => r.presentationId !== baseId).map(r => {
    const multiplier = locations[0].stock.packs.find(p => p.id === r.presentationId)?.baseUnits;
    if (!multiplier) throw new MaterialStockError('Unknown material presentation.');
    const capacities = locations.map((l, i) => {
      const p = l.stock.packs.find(p => p.id === r.presentationId);
      const reserved = availability[i].presentations.find(p => p.id === r.presentationId)?.reservedQuantity ?? 0;
      return p ? p.quantity - reserved : 0;
    });
    return { ...r, multiplier, capacities };
  }).sort((a, b) => a.capacities.filter(Boolean).length - b.capacities.filter(Boolean).length || b.multiplier - a.multiplier || a.presentationId - b.presentationId);
  for (const r of requested) if (!Number.isSafeInteger(r.quantity) || r.quantity <= 0) throw new MaterialStockError('Material quantities must be positive whole numbers.');
  const neededBase = (base?.quantity ?? 0) + packages.reduce((sum, r) => sum + r.quantity * r.multiplier, 0);
  if (remainingCapacity.reduce((sum, n) => sum + n, 0) < neededBase) throw new MaterialStockError('The requested material quantity is no longer available.');
  const allocated: Allocation[] = [];
  let visited = 0;
  const impossible = new Set<string>();
  const enoughForRemaining = (index: number) => packages.slice(index).every(p => p.capacities.reduce((sum, count, i) => sum + Math.min(count, Math.floor(remainingCapacity[i] / p.multiplier)), 0) >= p.quantity);
  const solve = (index: number): boolean => {
    if (index === packages.length) return true;
    if (++visited > 100000) throw new MaterialStockError('This combination of packages needs assistance from the store to allocate inventory.');
    const key = `${index}:${remainingCapacity.join(',')}`;
    if (impossible.has(key) || !enoughForRemaining(index)) return false;
    const p = packages[index];
    // Prefer locations that do not hold another requested package available nowhere else.
    const candidates = locations.map((l, i) => ({ i, storeId: l.storeId, future: packages.slice(index + 1).reduce((sum, other) => sum + (other.capacities[i] ? 1 / other.capacities.filter(Boolean).length : 0), 0) }))
      .filter(c => p.capacities[c.i] > 0 && remainingCapacity[c.i] >= p.multiplier)
      .sort((a, b) => a.future - b.future || a.storeId - b.storeId);
    const distribute = (position: number, remaining: number): boolean => {
      if (!remaining) return solve(index + 1);
      if (position >= candidates.length) return false;
      const i = candidates[position].i;
      const maximum = Math.min(remaining, p.capacities[i], Math.floor(remainingCapacity[i] / p.multiplier));
      const laterMaximum = candidates.slice(position + 1).reduce((sum, c) => sum + Math.min(p.capacities[c.i], Math.floor(remainingCapacity[c.i] / p.multiplier)), 0);
      const minimum = Math.max(0, remaining - laterMaximum);
      for (let count = maximum; count >= minimum; count--) {
        if (++visited > 100000) throw new MaterialStockError('This combination of packages needs assistance from the store to allocate inventory.');
        remainingCapacity[i] -= count * p.multiplier;
        if (count) allocated.push({ storeId: locations[i].storeId, presentationId: p.presentationId, quantity: count });
        if (enoughForRemaining(index + 1) && distribute(position + 1, remaining - count)) return true;
        if (count) allocated.pop();
        remainingCapacity[i] += count * p.multiplier;
      }
      return false;
    };
    if (distribute(0, p.quantity)) return true;
    impossible.add(key);
    return false;
  };
  if (!solve(0)) throw new MaterialStockError('The requested package quantities are no longer available together.');
  let baseRemaining = base?.quantity ?? 0;
  for (let i = 0; i < locations.length && baseRemaining; i++) {
    const quantity = Math.min(baseRemaining, remainingCapacity[i]);
    if (quantity) allocated.push({ storeId: locations[i].storeId, presentationId: baseId, quantity });
    baseRemaining -= quantity;
  }
  if (baseRemaining) throw new MaterialStockError('The requested loose material quantity is no longer available.');
  return allocated;
}
