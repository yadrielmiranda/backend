import { BadRequestException, ConflictException } from '@nestjs/common';

export type PartType = 'DOOR' | 'FRAME' | 'WINDOW';
export type PartKey = PartType | 'UNKNOWN';
export type PartCounts = Partial<Record<PartKey, number>>;
const PART_TYPES: PartType[] = ['DOOR', 'FRAME', 'WINDOW'];
const PART_KEYS: PartKey[] = [...PART_TYPES, 'UNKNOWN'];
const STATES = ['inTransit', 'onHand', 'unassigned', 'released'] as const;

export type TrackingStock = {
  partBalances?: unknown;
  inTransit: number;
  onHand: number;
  unassigned: number;
  released: number;
  storeBalances?: { storeId: number; onHand: number }[];
};
type Bucket = {
  inTransit: number;
  onHand: number;
  unassigned: number;
  released: number;
  stores: Record<string, number>;
};
export type PartBalanceSnapshot = {
  v: 1;
  expected: PartCounts;
  balances: Record<PartKey, Bucket>;
};
export type PartMovementDetails = {
  v: 1;
  before: PartBalanceSnapshot;
  after: PartBalanceSnapshot;
  partQuantities: PartCounts;
  deltas: {
    inTransit: PartCounts;
    onHand: PartCounts;
    unassigned: PartCounts;
    released: PartCounts;
    stores: Record<string, PartCounts>;
  };
};
export type PartMovementInput = {
  quantity: number;
  transitDelta?: number;
  onHandDelta?: number;
  releasedDelta?: number;
  fromStoreId?: number | null;
  toStoreId?: number | null;
  partType?: PartType;
  partQuantities?: PartCounts;
  // A pickup-scoped source may differ from the globally available type balances.
  sourcePartQuantities?: PartCounts;
  undoDetails?: unknown;
};
type Location = { state: 'inTransit' | 'onHand' | 'released'; storeId?: number | null };

const emptyBucket = (): Bucket => ({
  inTransit: 0, onHand: 0, unassigned: 0, released: 0, stores: {},
});
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const total = (counts: PartCounts) => PART_KEYS.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const validQuantity = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const fail = (message = 'Part balances do not match warehouse stock. Review this unit before moving it.'): never => {
  throw new ConflictException(message);
};

export function expectedPartCounts(expectedParts: number | null, separateFrame: boolean): PartCounts {
  if (expectedParts === null || expectedParts === undefined) return {};
  if (!Number.isInteger(expectedParts) || expectedParts < 1 || expectedParts > 200)
    throw new BadRequestException('Set expected physical parts between 1 and 200 first.');
  return separateFrame
    ? { DOOR: expectedParts - 1, FRAME: 1 }
    : { WINDOW: expectedParts };
}

export function cleanPartCounts(value: unknown): PartCounts {
  if (!record(value) || Object.keys(value).some(key => !PART_KEYS.includes(key as PartKey)))
    throw new BadRequestException('Choose valid factory part types and quantities.');
  const result: PartCounts = {};
  for (const key of PART_KEYS) {
    if (value[key] === undefined) continue;
    if (!validQuantity(value[key]) || Number(value[key]) > 200)
      throw new BadRequestException('Part quantities must be whole numbers between 0 and 200.');
    if (Number(value[key]) > 0) result[key] = Number(value[key]);
  }
  return result;
}

function sameCounts(left: PartCounts, right: PartCounts) {
  return PART_KEYS.every(key => (left[key] ?? 0) === (right[key] ?? 0));
}

function at(snapshot: PartBalanceSnapshot, location: Location): PartCounts {
  const result: PartCounts = {};
  for (const key of PART_KEYS) {
    const bucket = snapshot.balances[key];
    const value = location.state !== 'onHand'
      ? bucket[location.state]
      : location.storeId == null ? bucket.unassigned : bucket.stores[String(location.storeId)] ?? 0;
    if (value) result[key] = value;
  }
  return result;
}

function stateCounts(snapshot: PartBalanceSnapshot, state: typeof STATES[number]): PartCounts {
  return Object.fromEntries(PART_KEYS.filter(key => snapshot.balances[key][state] !== 0)
    .map(key => [key, snapshot.balances[key][state]]));
}

function storeIds(snapshot: PartBalanceSnapshot) {
  return [...new Set(PART_KEYS.flatMap(key => Object.keys(snapshot.balances[key].stores)))]
    .sort((a, b) => Number(a) - Number(b));
}

function assertSnapshot(snapshot: PartBalanceSnapshot, allowMissingExpected = false) {
  if (!record(snapshot) || snapshot.v !== 1 || !record(snapshot.expected) || !record(snapshot.balances) ||
      Object.keys(snapshot.expected).some(key => !PART_TYPES.includes(key as PartType)) ||
      Object.values(snapshot.expected).some(value => !validQuantity(value) || Number(value) > 200) ||
      total(snapshot.expected) > 200)
    fail('Saved factory part balances are invalid. Review this unit before moving it.');
  for (const key of PART_KEYS) {
    const bucket = snapshot.balances[key];
    if (!record(bucket) || !record(bucket.stores) ||
        STATES.some(state => !validQuantity(bucket[state])) ||
        Object.entries(bucket.stores).some(([id, n]) => !/^[1-9]\d*$/.test(id) ||
          !Number.isSafeInteger(Number(id)) || !validQuantity(n)))
      fail('Saved factory part balances are invalid. Review this unit before moving it.');
    const assigned = Object.values(bucket.stores).reduce((sum, n) => sum + n, 0);
    if (assigned + bucket.unassigned !== bucket.onHand) fail();
    if (key !== 'UNKNOWN' && bucket.inTransit + bucket.onHand + bucket.released > (snapshot.expected[key] ?? 0))
      throw new BadRequestException(`All expected ${key} parts for this unit are already accounted for.`);
  }
  const accounted = PART_KEYS.reduce((sum, key) => {
    const bucket = snapshot.balances[key];
    return sum + bucket.inTransit + bucket.onHand + bucket.released;
  }, 0);
  if ((!allowMissingExpected || total(snapshot.expected) > 0) && accounted > total(snapshot.expected))
    throw new BadRequestException('All expected parts for this unit are already accounted for.');
}

function readSnapshot(stock: TrackingStock, expectedParts: number | null, separateFrame: boolean) {
  const expected = expectedPartCounts(expectedParts, separateFrame);
  let snapshot: PartBalanceSnapshot;
  if (stock.partBalances == null) {
    snapshot = {
      v: 1, expected,
      balances: { DOOR: emptyBucket(), FRAME: emptyBucket(), WINDOW: emptyBucket(), UNKNOWN: emptyBucket() },
    };
    snapshot.balances.UNKNOWN = {
      inTransit: stock.inTransit, onHand: stock.onHand, unassigned: stock.unassigned,
      released: stock.released,
      stores: Object.fromEntries((stock.storeBalances ?? []).map(store => [String(store.storeId), store.onHand])),
    };
  } else {
    if (!record(stock.partBalances) || stock.partBalances.v !== 1 || !record(stock.partBalances.balances) ||
        PART_KEYS.some(key => !record((stock.partBalances as Record<string, any>).balances[key])))
      fail('Saved factory part balances are invalid. Review this unit before moving it.');
    snapshot = clone(stock.partBalances) as PartBalanceSnapshot;
    assertSnapshot(snapshot, true);
    // Preserve the recorded classification across later catalog edits. A reviewed
    // PARTS operation is the only service path that changes the total.
    if (total(snapshot.expected) !== expectedParts) snapshot.expected = expected;
  }
  assertSnapshot(snapshot, expectedParts == null);
  for (const state of STATES) {
    if (total(stateCounts(snapshot, state)) !== stock[state]) fail();
  }
  const stores = new Map((stock.storeBalances ?? []).map(store => [String(store.storeId), store.onHand]));
  for (const id of new Set([...stores.keys(), ...storeIds(snapshot)])) {
    if (total(at(snapshot, { state: 'onHand', storeId: Number(id) })) !== (stores.get(id) ?? 0)) fail();
  }
  return snapshot;
}

export function partTracking(stock: TrackingStock, expectedParts: number | null, separateFrame: boolean) {
  const snapshot = readSnapshot(stock, expectedParts, separateFrame);
  return {
    expected: snapshot.expected,
    inTransit: stateCounts(snapshot, 'inTransit'),
    onHand: stateCounts(snapshot, 'onHand'),
    unassigned: stateCounts(snapshot, 'unassigned'),
    released: stateCounts(snapshot, 'released'),
    stores: storeIds(snapshot).map(id => ({ id: Number(id), parts: at(snapshot, { state: 'onHand', storeId: Number(id) }) })),
    types: PART_TYPES.filter(key => (snapshot.expected[key] ?? 0) > 0),
  };
}

export function resolvePartQuantities(
  quantity: number,
  available: PartCounts | null,
  types: PartType[],
  partType?: PartType,
  partQuantities?: PartCounts,
): PartCounts {
  if (!validQuantity(quantity) || quantity > 200)
    throw new BadRequestException('Part quantities must be whole numbers between 0 and 200.');
  if (partType !== undefined && !PART_TYPES.includes(partType))
    throw new BadRequestException('Choose DOOR, FRAME or WINDOW.');
  const requested = partQuantities === undefined ? undefined : cleanPartCounts(partQuantities);
  if (partType && requested && !sameCounts(requested, { [partType]: quantity }))
    throw new BadRequestException('The selected type and part quantities do not match.');
  if (quantity === 0) {
    if (requested && total(requested) !== 0) throw new BadRequestException('Part quantities must match the movement quantity.');
    return {};
  }
  const result = requested ?? (partType ? { [partType]: quantity } : undefined);
  if (result) {
    if (total(result) !== quantity)
      throw new BadRequestException('Part quantities must match the movement quantity.');
    if (PART_TYPES.some(key => (result[key] ?? 0) > 0 && !types.includes(key)))
      throw new BadRequestException('This part type is not expected for this factory unit.');
    if (available === null && (result.UNKNOWN ?? 0) > 0)
      throw new BadRequestException('Choose the type of each new factory part.');
    return result;
  }
  if (available !== null) {
    const clean = cleanPartCounts(available);
    if (quantity > total(clean)) throw new BadRequestException('Not enough parts in the selected source.');
    if (quantity === total(clean)) return clean;
    const keys = PART_KEYS.filter(key => (clean[key] ?? 0) > 0);
    if (keys.length === 1) return { [keys[0]]: quantity };
    throw new BadRequestException({
      code: 'FACTORY_PART_QUANTITIES_REQUIRED',
      message: 'Choose how many DOOR, FRAME or WINDOW parts to move from this source.',
      available: clean,
    });
  }
  if (types.length === 1) return { [types[0]]: quantity };
  throw new BadRequestException({
    code: 'FACTORY_PART_TYPE_REQUIRED',
    message: 'Choose which factory part you are scanning.',
    types,
  });
}

function addAt(snapshot: PartBalanceSnapshot, location: Location, type: PartKey, delta: number) {
  const bucket = snapshot.balances[type];
  if (location.state !== 'onHand') bucket[location.state] += delta;
  else {
    bucket.onHand += delta;
    if (location.storeId == null) bucket.unassigned += delta;
    else {
      const id = String(location.storeId);
      bucket.stores[id] = (bucket.stores[id] ?? 0) + delta;
      if (bucket.stores[id] === 0) delete bucket.stores[id];
    }
  }
}

function consume(snapshot: PartBalanceSnapshot, source: Location, quantities: PartCounts) {
  const available = at(snapshot, source);
  const sourceName = source.state === 'onHand' && source.storeId == null ? 'Unassigned' : 'the selected source';
  // Reserve explicitly unclassified units first so typed refinements cannot use them twice.
  const unknown = quantities.UNKNOWN ?? 0;
  if (unknown > (available.UNKNOWN ?? 0))
    throw new BadRequestException(`Not enough unclassified parts in ${sourceName}.`);
  if (unknown) addAt(snapshot, source, 'UNKNOWN', -unknown);
  for (const type of PART_TYPES) {
    const quantity = quantities[type] ?? 0;
    const typed = Math.min(quantity, available[type] ?? 0);
    const missing = quantity - typed;
    if (missing > (at(snapshot, source).UNKNOWN ?? 0))
      throw new BadRequestException(`Not enough ${type} parts in ${sourceName}.`);
    if (typed) addAt(snapshot, source, type, -typed);
    if (missing) addAt(snapshot, source, 'UNKNOWN', -missing);
  }
}

function consumeExact(
  snapshot: PartBalanceSnapshot, source: Location, sourceQuantities: PartCounts, quantities: PartCounts,
) {
  const available = at(snapshot, source);
  if (total(sourceQuantities) !== total(quantities) ||
      PART_TYPES.some(key => (sourceQuantities[key] ?? 0) > (quantities[key] ?? 0)) ||
      (quantities.UNKNOWN ?? 0) > (sourceQuantities.UNKNOWN ?? 0))
    throw new BadRequestException('The selected source parts do not match the requested types.');
  for (const key of PART_KEYS) {
    if ((sourceQuantities[key] ?? 0) > (available[key] ?? 0))
      throw new BadRequestException(`Not enough ${key} parts in the selected source.`);
    if (sourceQuantities[key]) addAt(snapshot, source, key, -sourceQuantities[key]!);
  }
}

function difference(before: PartCounts, after: PartCounts): PartCounts {
  return Object.fromEntries(PART_KEYS.map(key => [key, (after[key] ?? 0) - (before[key] ?? 0)])
    .filter(([, value]) => value !== 0));
}

function details(before: PartBalanceSnapshot, after: PartBalanceSnapshot, partQuantities: PartCounts): PartMovementDetails {
  const ids = [...new Set([...storeIds(before), ...storeIds(after)])];
  return {
    v: 1, before, after, partQuantities,
    deltas: {
      inTransit: difference(stateCounts(before, 'inTransit'), stateCounts(after, 'inTransit')),
      onHand: difference(stateCounts(before, 'onHand'), stateCounts(after, 'onHand')),
      unassigned: difference(stateCounts(before, 'unassigned'), stateCounts(after, 'unassigned')),
      released: difference(stateCounts(before, 'released'), stateCounts(after, 'released')),
      stores: Object.fromEntries(ids.map(id => [id, difference(
        at(before, { state: 'onHand', storeId: Number(id) }),
        at(after, { state: 'onHand', storeId: Number(id) }),
      )]).filter(([, value]) => Object.keys(value).length > 0)),
    },
  };
}

function sameBalances(left: PartBalanceSnapshot, right: PartBalanceSnapshot) {
  return STATES.every(state => sameCounts(stateCounts(left, state), stateCounts(right, state))) &&
    [...new Set([...storeIds(left), ...storeIds(right)])].every(id => sameCounts(
      at(left, { state: 'onHand', storeId: Number(id) }),
      at(right, { state: 'onHand', storeId: Number(id) }),
    ));
}

export function applyPartMovement(
  stock: TrackingStock,
  expectedParts: number | null,
  separateFrame: boolean,
  input: PartMovementInput,
): { partBalances: PartBalanceSnapshot; partDetails: PartMovementDetails } {
  const before = readSnapshot(stock, expectedParts, separateFrame);
  if (expectedParts == null)
    throw new BadRequestException('An administrator must set the expected physical parts for this unit first.');
  if (input.undoDetails != null) {
    const original = input.undoDetails as PartMovementDetails;
    if (!record(original) || original.v !== 1 || !record(original.before) || !record(original.after))
      fail('This movement has invalid part details and cannot be undone.');
    assertSnapshot(original.before);
    assertSnapshot(original.after);
    if (!sameBalances(before, original.after))
      fail('This unit has newer part movements. Refresh before undoing this reading.');
    const after = clone(original.before);
    after.expected = before.expected;
    assertSnapshot(after);
    return { partBalances: after, partDetails: details(before, after, original.partQuantities ?? {}) };
  }
  const quantity = input.quantity;
  const deltas = {
    inTransit: input.transitDelta ?? 0,
    onHand: input.onHandDelta ?? 0,
    released: input.releasedDelta ?? 0,
  };
  if (!validQuantity(quantity) || quantity > 200 ||
      Object.values(deltas).some(delta => !Number.isInteger(delta) || (delta !== 0 && Math.abs(delta) !== quantity)))
    throw new BadRequestException('Part quantities do not match this movement.');
  const sources: Location[] = [];
  const destinations: Location[] = [];
  for (const state of ['inTransit', 'onHand', 'released'] as const) {
    if (deltas[state] < 0) sources.push({ state, ...(state === 'onHand' ? { storeId: input.fromStoreId ?? null } : {}) });
    if (deltas[state] > 0) destinations.push({ state, ...(state === 'onHand' ? { storeId: input.toStoreId ?? null } : {}) });
  }
  // Transfers keep global onHand unchanged, while moving an exact breakdown.
  if (quantity > 0 && Object.values(deltas).every(delta => delta === 0) &&
      input.fromStoreId !== undefined && input.toStoreId !== undefined && input.fromStoreId !== input.toStoreId) {
    sources.push({ state: 'onHand', storeId: input.fromStoreId });
    destinations.push({ state: 'onHand', storeId: input.toStoreId });
  }
  if (sources.length > 1 || destinations.length > 1 ||
      (quantity > 0 && sources.length + destinations.length === 0))
    throw new BadRequestException('This part movement must have one source and one destination.');
  if (input.sourcePartQuantities !== undefined && !sources[0])
    throw new BadRequestException('Exact source parts require a source location.');
  const sourceQuantities = input.sourcePartQuantities === undefined
    ? undefined : cleanPartCounts(input.sourcePartQuantities);
  const types = PART_TYPES.filter(key => (before.expected[key] ?? 0) > 0);
  const quantities = resolvePartQuantities(quantity, sources[0] ? sourceQuantities ?? at(before, sources[0]) : null,
    types, input.partType, input.partQuantities);
  const after = clone(before);
  if (sources[0]) {
    if (sourceQuantities) consumeExact(after, sources[0], sourceQuantities, quantities);
    else consume(after, sources[0], quantities);
  }
  if (destinations[0]) {
    for (const key of PART_KEYS) {
      if (quantities[key]) addAt(after, destinations[0], key, quantities[key]!);
    }
  }
  assertSnapshot(after);
  return { partBalances: after, partDetails: details(before, after, quantities) };
}

export function reconcilePartCount(
  stock: TrackingStock,
  expectedParts: number | null,
  separateFrame: boolean,
  input: { storeId?: number | null; allStores?: boolean; expected: PartCounts; counted: PartCounts },
): { partBalances: PartBalanceSnapshot; partDetails: PartMovementDetails } {
  const before = readSnapshot(stock, expectedParts, separateFrame);
  const expected = cleanPartCounts(input.expected);
  const counted = cleanPartCounts(input.counted);
  const location: Location = { state: 'onHand', storeId: input.allStores ? null : input.storeId ?? null };
  const current = input.allStores ? stateCounts(before, 'onHand') : at(before, location);
  if (!sameCounts(current, expected))
    fail('The part balances changed after this count started. Refresh and review the count.');
  const target = { ...counted };
  if (input.allStores) {
    for (const key of PART_KEYS) {
      const assigned = before.balances[key].onHand - before.balances[key].unassigned;
      const remaining = (target[key] ?? 0) - assigned;
      if (remaining < 0)
        throw new BadRequestException('Count each affected store separately to classify or reduce its parts.');
      target[key] = remaining;
    }
  }
  const after = clone(before);
  const previous = at(before, location);
  for (const key of PART_KEYS) addAt(after, location, key, (target[key] ?? 0) - (previous[key] ?? 0));
  assertSnapshot(after, expectedParts == null);
  return { partBalances: after, partDetails: details(before, after, counted) };
}
