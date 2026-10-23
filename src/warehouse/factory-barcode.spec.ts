import { barcodeLine, expectedPhysicalParts, parseFactoryBarcode } from './warehouse-parts';

describe('factory barcode compatibility', () => {
  it.each(['I12345', 'i0012345', '12345', ' 12345\r\n'])(
    'keeps the same line for legacy barcode %s without inventing a type', value => {
      expect(parseFactoryBarcode(value)).toEqual({ lineNumber: '12345' });
    },
  );

  it.each(['DOOR', 'FRAME', 'WINDOW'] as const)(
    'recognizes %s without changing the line identity', partType => {
      expect(parseFactoryBarcode(`0012345-${partType.toLowerCase()}`)).toEqual({
        lineNumber: '12345', partType,
      });
      expect(barcodeLine(`12345-${partType}`)).toBe('12345');
    },
  );

  it.each(['1134547-SIDELITE', '001134547-sidelite', ' 1134547-SiDeLiTe\r\n'])(
    'counts sidelite label %s in the existing door-panel group', value => {
      expect(parseFactoryBarcode(value)).toEqual({ lineNumber: '1134547', partType: 'DOOR' });
      expect(barcodeLine(value)).toBe('1134547');
    },
  );

  it.each(['0-FRAME', '123-OTHER', '123-DOOR-extra', 'I123-DOOR', '123 -FRAME', '-WINDOW', null, '0-SIDELITE', 'I123-SIDELITE', '123-SIDELITE-extra'])(
    'rejects an invalid factory barcode %s', value => {
      expect(() => parseFactoryBarcode(value)).toThrow();
    },
  );

  it('preserves the existing expected quantity rules including non-door totals', () => {
    expect(expectedPhysicalParts({ family: 'FRENCH_DOOR', panelCount: 2 })).toBe(3);
    expect(expectedPhysicalParts({ family: 'SLIDING_DOOR', panelCount: 3 })).toBe(4);
    expect(expectedPhysicalParts({ family: 'HORIZONTAL_SLIDER', panelCount: 3 })).toBe(3);
  });
});
