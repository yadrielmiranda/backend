import { matchingPieceDesignSnapshot, pieceFrameColorName } from './piece-frame-color';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';

const snapshot = {
  version: 1, systemId: 3,
  design: { id: 4, name: 'Custom design', imageUrl: null },
  color: { id: 5, name: 'Oak', hexCode: '#995522' },
};
const piece = { idSyst: 3, idDesign: 4, idDesignColor: 5, designSnapshot: snapshot,
  idFC: 8, fColor: { color: 'Bronze' }, price: '99.00', qty: 1 };

describe('finished garage frame color', () => {
  it('uses a saved design color while preserving the original frame and price inputs', () => {
    expect(pieceFrameColorName(piece)).toBe('Oak');
    expect(piece).toMatchObject({ idFC: 8, fColor: { color: 'Bronze' }, price: '99.00' });
  });

  it('reads a historical design snapshot without requiring a current catalog lookup', () => {
    expect(pieceFrameColorName({ designSnapshot: snapshot })).toBe('Oak');
  });

  it.each([
    { idDesign: null }, { idDesignColor: null }, { idDesign: 99 },
    { idDesignColor: 99 }, { idSyst: 99 }, { idSyst: null },
    { designSnapshot: null }, { designSnapshot: {} },
    { designSnapshot: { ...snapshot, color: { ...snapshot.color, hexCode: 'red' } } },
    { designSnapshot: { ...snapshot, color: { ...snapshot.color, name: ' ' } } },
    { designSnapshot: { ...snapshot, design: { ...snapshot.design, id: -1 } } },
  ])('does not let a removed, stale or malformed design override the normal frame: %p', changes => {
    const changed = { ...piece, ...changes };
    expect(matchingPieceDesignSnapshot(changed)).toBeNull();
    expect(pieceFrameColorName(changed)).toBe('Bronze');
  });

  it('uses the normal frame without design and preserves missing values', () => {
    expect(pieceFrameColorName({ fColor: { color: ' White ' } })).toBe('White');
    expect(pieceFrameColorName({})).toBeNull();
  });

  it('captures the effective name for installation without overwriting base pricing or prior snapshots', () => {
    const service = Object.create(InstallationWorkflowService.prototype) as any;
    const prior = { ...piece, designSnapshot: null, idDesign: null, idDesignColor: null };
    const original = service.sourceSnapshot(prior);
    const designed = service.sourceSnapshot(piece);
    expect(original.frameColorName).toBe('Bronze');
    expect(designed).toMatchObject({ frameColorName: 'Oak', idFC: 8, price: '99.00', designSnapshot: snapshot });
    expect(original.frameColorName).toBe('Bronze');
  });
});
