/** Physical quantities count packages, not their contained base units. */
export type MaterialStockPack = { id: number; baseUnits: number; quantity: number };
export type MaterialReservation = { presentationId: number; quantity: number };
export type MaterialStockState = {
  basePresentationId: number;
  packs: MaterialStockPack[];
  reservations: MaterialReservation[];
};

export class MaterialStockError extends Error {}

const integer = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
const total = (packs: MaterialStockPack[]) => packs.reduce((sum, p) => sum + p.quantity * p.baseUnits, 0);

/** Whole-package reservations must remain whole; loose-unit reservations can use free closed packs. */
export function materialAvailability(state: MaterialStockState) {
  const ids = new Set<number>();
  for (const p of state.packs) {
    if (ids.has(p.id) || !integer(p.quantity) || !integer(p.baseUnits) || p.baseUnits < 1)
      throw new MaterialStockError('Invalid material stock.');
    ids.add(p.id);
  }
  if (state.packs.find(p => p.id === state.basePresentationId)?.baseUnits !== 1)
    throw new MaterialStockError('A base-unit presentation is required.');
  const reserved = new Map<number, number>();
  for (const r of state.reservations) {
    if (!ids.has(r.presentationId) || !integer(r.quantity))
      throw new MaterialStockError('Invalid material reservation.');
    reserved.set(r.presentationId, (reserved.get(r.presentationId) ?? 0) + r.quantity);
  }
  let reservedBaseQuantity = 0;
  for (const p of state.packs) {
    const quantity = reserved.get(p.id) ?? 0;
    if (p.id !== state.basePresentationId && quantity > p.quantity)
      throw new MaterialStockError('These packages are reserved for another sale.');
    reservedBaseQuantity += quantity * p.baseUnits;
  }
  const totalBaseQuantity = total(state.packs);
  if (!integer(totalBaseQuantity) || !integer(reservedBaseQuantity))
    throw new MaterialStockError('Material quantity exceeds the supported limit.');
  const availableBaseQuantity = totalBaseQuantity - reservedBaseQuantity;
  if (availableBaseQuantity < 0)
    throw new MaterialStockError('Insufficient unreserved material stock.');
  return {
    totalBaseQuantity,
    reservedBaseQuantity,
    availableBaseQuantity,
    presentations: state.packs.map(p => ({
      id: p.id,
      quantity: p.quantity,
      reservedQuantity: reserved.get(p.id) ?? 0,
      availableQuantity: p.id === state.basePresentationId ? availableBaseQuantity : Math.min(
        p.quantity - (reserved.get(p.id) ?? 0), Math.floor(availableBaseQuantity / p.baseUnits),
      ),
    })),
  };
}

/** Withdraw base units by opening the smallest available packages only when needed. */
export function withdrawMaterial(state: MaterialStockState, presentationId: number, quantity: number) {
  if (!integer(quantity) || quantity < 1) throw new MaterialStockError('Quantity must be a positive whole number.');
  const availability = materialAvailability(state);
  const available = availability.presentations.find(p => p.id === presentationId);
  if (!available || quantity > available.availableQuantity)
    throw new MaterialStockError('Insufficient unreserved material stock.');
  const packs = state.packs.map(p => ({ ...p }));
  const target = packs.find(p => p.id === presentationId)!;
  const opened: { presentationId: number; quantity: number; baseUnits: number }[] = [];
  if (presentationId === state.basePresentationId) {
    let needed = Math.max(0, quantity - target.quantity);
    for (const pack of packs.filter(p => p.id !== presentationId).sort((a, b) => a.baseUnits - b.baseUnits || a.id - b.id)) {
      if (!needed) break;
      const reserved = availability.presentations.find(p => p.id === pack.id)!.reservedQuantity;
      const count = Math.min(pack.quantity - reserved, Math.ceil(needed / pack.baseUnits));
      if (count <= 0) continue;
      pack.quantity -= count;
      target.quantity += count * pack.baseUnits;
      opened.push({ presentationId: pack.id, quantity: count, baseUnits: count * pack.baseUnits });
      needed = Math.max(0, quantity - target.quantity);
    }
  }
  target.quantity -= quantity;
  const next = { ...state, packs };
  materialAvailability(next);
  return { ...next, opened };
}

/** Explicit opening or preparing packages changes presentation, never total inventory. */
export function repackMaterial(state: MaterialStockState, presentationId: number, quantity: number, action: 'OPEN' | 'PACK') {
  if (!integer(quantity) || quantity < 1) throw new MaterialStockError('Quantity must be a positive whole number.');
  const pack = state.packs.find(p => p.id === presentationId);
  if (!pack || pack.id === state.basePresentationId || pack.baseUnits <= 1)
    throw new MaterialStockError('Select a non-base package presentation.');
  materialAvailability(state);
  const packs = state.packs.map(p => ({ ...p }));
  const target = packs.find(p => p.id === presentationId)!;
  const base = packs.find(p => p.id === state.basePresentationId)!;
  if (action === 'OPEN') {
    target.quantity -= quantity;
    base.quantity += quantity * pack.baseUnits;
  } else {
    // Packing consumes physically loose stock. It must not silently open other packages.
    base.quantity -= quantity * pack.baseUnits;
    target.quantity += quantity;
  }
  const next = { ...state, packs };
  materialAvailability(next);
  if (total(packs) !== total(state.packs)) throw new MaterialStockError('Package conversion must preserve inventory.');
  return next;
}
