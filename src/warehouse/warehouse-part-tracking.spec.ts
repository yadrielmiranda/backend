import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  applyPartMovement,
  partTracking,
  reconcilePartCount,
  TrackingStock,
} from './warehouse-part-tracking';

const empty = (changes: Partial<TrackingStock> = {}): TrackingStock => ({
  inTransit: 0, onHand: 0, unassigned: 0, released: 0, storeBalances: [], ...changes,
});

describe('factory part tracking', () => {
  it('collects a known door when normalized store arguments are null', () => {
    const result = applyPartMovement(empty(), 3, true, {
      quantity: 1, transitDelta: 1, fromStoreId: null, toStoreId: null, partType: 'DOOR',
    });
    expect(result.partDetails.deltas.inTransit).toEqual({ DOOR: 1 });
    expect(result.partDetails.deltas.onHand).toEqual({});
    expect(partTracking(empty({ inTransit: 1, partBalances: result.partBalances }), 3, true).inTransit)
      .toEqual({ DOOR: 1 });
  });

  it('requires the operator to identify an ambiguous newly collected part', () => {
    try {
      applyPartMovement(empty(), 3, true, { quantity: 1, transitDelta: 1 });
      throw new Error('Expected an ambiguous type error');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'FACTORY_PART_TYPE_REQUIRED', types: ['DOOR', 'FRAME'],
      });
    }
  });

  it('preserves the existing expected quantity for a WINDOW unit', () => {
    const result = applyPartMovement(empty(), 4, false, { quantity: 1, transitDelta: 1 });
    expect(result.partBalances.expected).toEqual({ WINDOW: 4 });
    expect(result.partDetails.deltas.inTransit).toEqual({ WINDOW: 1 });
  });

  it('preserves the saved type profile when a later catalog edit changes the product family', () => {
    const collected = applyPartMovement(empty(), 3, true, {
      quantity: 1, transitDelta: 1, partType: 'DOOR',
    });
    const current = empty({ inTransit: 1, partBalances: collected.partBalances });
    expect(partTracking(current, 3, false).expected).toEqual({ DOOR: 2, FRAME: 1 });
    expect(partTracking(current, 3, false).types).toEqual(['DOOR', 'FRAME']);
  });

  it('rejects a malformed persisted expected profile instead of silently replacing it', () => {
    const collected = applyPartMovement(empty(), 3, true, {
      quantity: 1, transitDelta: 1, partType: 'DOOR',
    });
    collected.partBalances.expected = { UNKNOWN: 3 };
    expect(() => partTracking(empty({ inTransit: 1, partBalances: collected.partBalances }), 3, true))
      .toThrow('Saved factory part balances are invalid');
  });

  it('rejects an extra door even when the expected frame has not arrived', () => {
    const first = applyPartMovement(empty(), 3, true, {
      quantity: 2, transitDelta: 2, partType: 'DOOR',
    });
    const stock = empty({ inTransit: 2, partBalances: first.partBalances });
    expect(() => applyPartMovement(stock, 3, true, {
      quantity: 1, transitDelta: 1, partType: 'DOOR',
    })).toThrow('All expected DOOR parts');
    expect(() => applyPartMovement(stock, 3, true, {
      quantity: 1, transitDelta: 1, partType: 'WINDOW',
    })).toThrow('not expected');
  });

  it('releases transit stock without inventing an on-hand transfer', () => {
    const initial = empty({ inTransit: 1 });
    const result = applyPartMovement(initial, 3, true, {
      quantity: 1, transitDelta: -1, releasedDelta: 1,
      fromStoreId: null, toStoreId: null, partType: 'FRAME',
    });
    expect(result.partDetails.deltas.inTransit).toEqual({ UNKNOWN: -1 });
    expect(result.partDetails.deltas.released).toEqual({ FRAME: 1 });
    expect(result.partDetails.deltas.onHand).toEqual({});
  });

  it('refines only the selected legacy part and undo restores its exact unknown origin', () => {
    const initial = empty({ inTransit: 2 });
    const received = applyPartMovement(initial, 3, true, {
      quantity: 1, transitDelta: -1, onHandDelta: 1, toStoreId: 7, partType: 'FRAME',
    });
    expect(received.partDetails.deltas.inTransit).toEqual({ UNKNOWN: -1 });
    expect(received.partDetails.deltas.stores).toEqual({ '7': { FRAME: 1 } });
    const current = empty({
      inTransit: 1, onHand: 1, storeBalances: [{ storeId: 7, onHand: 1 }],
      partBalances: received.partBalances,
    });
    const undone = applyPartMovement(current, 3, true, {
      quantity: 1, transitDelta: 1, onHandDelta: -1, fromStoreId: 7,
      undoDetails: received.partDetails,
    });
    expect(undone.partBalances).toEqual(received.partDetails.before);
    expect(undone.partDetails.deltas.inTransit).toEqual({ UNKNOWN: 1 });
  });

  it('consumes the scoped UNKNOWN lot instead of a typed lot belonging to another pickup', () => {
    const collected = applyPartMovement(empty({ inTransit: 1 }), 3, true, {
      quantity: 1, transitDelta: 1, partType: 'DOOR',
    });
    const result = applyPartMovement(empty({ inTransit: 2, partBalances: collected.partBalances }), 3, true, {
      quantity: 1, transitDelta: -1, releasedDelta: 1,
      partType: 'DOOR', sourcePartQuantities: { UNKNOWN: 1 },
    });
    expect(result.partDetails.deltas.inTransit).toEqual({ UNKNOWN: -1 });
    expect(result.partBalances.balances.DOOR.inTransit).toBe(1);
    expect(result.partBalances.balances.UNKNOWN.inTransit).toBe(0);
    expect(result.partBalances.balances.DOOR.released).toBe(1);
  });

  it('keeps unknown types when the entire source moves without a classification', () => {
    const stock = empty({ onHand: 2, storeBalances: [{ storeId: 4, onHand: 2 }] });
    const moved = applyPartMovement(stock, 3, true, {
      quantity: 2, fromStoreId: 4, toStoreId: 8,
    });
    expect(moved.partDetails.deltas.stores).toEqual({
      '4': { UNKNOWN: -2 }, '8': { UNKNOWN: 2 },
    });
    expect(moved.partDetails.deltas.onHand).toEqual({});
  });

  it('classifies a store count without changing its total stock', () => {
    const stock = empty({ onHand: 2, storeBalances: [{ storeId: 4, onHand: 2 }] });
    const counted = reconcilePartCount(stock, 3, true, {
      storeId: 4, expected: { UNKNOWN: 2 }, counted: { DOOR: 1, FRAME: 1 },
    });
    expect(counted.partDetails.deltas.onHand).toEqual({ DOOR: 1, FRAME: 1, UNKNOWN: -2 });
    const current = { ...stock, partBalances: counted.partBalances };
    expect(partTracking(current, 3, true).onHand).toEqual({ DOOR: 1, FRAME: 1 });
  });

  it('does not redistribute an ALL count into unknown store locations', () => {
    const stock = empty({ onHand: 2, storeBalances: [{ storeId: 4, onHand: 2 }] });
    expect(() => reconcilePartCount(stock, 3, true, {
      allStores: true, expected: { UNKNOWN: 2 }, counted: { DOOR: 1, FRAME: 1 },
    })).toThrow('affected store separately');
  });

  it('detects a mismatch between the typed ledger and the existing aggregate stock', () => {
    const collected = applyPartMovement(empty(), 3, true, {
      quantity: 1, transitDelta: 1, partType: 'DOOR',
    });
    expect(() => partTracking(empty({ partBalances: collected.partBalances }), 3, true))
      .toThrow(ConflictException);
  });
});
