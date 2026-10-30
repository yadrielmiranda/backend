import {
  DiagramFamily,
  DimensionMode,
  DimensionRuleType,
  PricingComponentType,
} from '@prisma/client';
import { CreatePieceDto } from '@/pieces/dto/create-piece.dto';
import { EstimateDimensionValidationService } from './estimate-dimension-validation.service';

function fixture({
  family = DiagramFamily.PIVOT_DOOR,
  dimensionMode = DimensionMode.ECO_WINDOWS_DOOR,
  sideliteQuantity = 1,
  hasTransom = true,
}: {
  family?: DiagramFamily;
  dimensionMode?: DimensionMode;
  sideliteQuantity?: number;
  hasTransom?: boolean;
} = {}) {
  const service = new EstimateDimensionValidationService();
  const grid = (
    ruleType: DimensionRuleType,
    widths: number[],
    heights: number[],
    pressure: number,
  ) => widths.flatMap(widthIn => heights.map(heightIn => ({
    ruleType, widthIn, heightIn, dpPosPsf: pressure, dpNegPsf: -pressure,
  })));
  const rules = [
    ...grid(DimensionRuleType.DOOR, [24, 48, 60], [80, 100, 120], 70),
    ...(sideliteQuantity > 0
      ? grid(DimensionRuleType.SIDELITE, [12, 18, 36], [80, 100, 120], 60)
      : []),
    ...(hasTransom
      ? grid(DimensionRuleType.MAIN, [24, 48, 60], [90, 120], 50)
      : []),
  ];
  const tx: any = {
    config: { findUnique: jest.fn(async () => ({
      conf: 'Custom entry configuration',
      prod: { diagramFamily: family },
    })) },
    sysConf: { findUnique: jest.fn(async () => ({
      dimensionMode,
      pricingComponents: [
        { componentType: PricingComponentType.DOOR, quantity: null },
        ...(sideliteQuantity > 0
          ? [{ componentType: PricingComponentType.SIDELITE, quantity: sideliteQuantity }]
          : []),
      ],
    })) },
    sysConfReinforcementOption: { findMany: jest.fn(async () => []) },
    dimensionPolicy: { findFirst: jest.fn(async () => ({
      roundingRule: 'ROUND_UP_TO_NEXT', rules,
    })) },
  };
  const piece: CreatePieceDto = {
    idProd: 1, idBrand: 1, idSyst: 1, idConf: 1, idFC: 1,
    idCryst: 1, idTint: 1, idCoat: 1, idPrivacy: 1,
    mark: 'Pivot', qty: 1,
    width: '80', height: '120', doorWidth: '45', doorHeight: '100',
  };
  const validate = (overrides: Partial<CreatePieceDto> = {}) =>
    service.validateAgainstDimensionPolicy({ ...piece, ...overrides }, tx);
  return { validate };
}

describe('Pivot Door dimension policy with a transom', () => {
  it.each([1, 2])(
    'checks MAIN at door width and opening height with %i sidelite(s)',
    async sideliteQuantity => {
      const f = fixture({ sideliteQuantity });

      // The 80-inch opening exceeds MAIN's 60-inch maximum, but the door is 45.
      await expect(f.validate()).resolves.toMatchObject({
        ok: true,
        dpPos: 50,
        dpNeg: -50,
        usedRange: { w: [48, 48], h: [120, 120] },
      });
    },
  );

  it.each([DiagramFamily.FRENCH_DOOR, DiagramFamily.GENERIC])(
    'continues checking the full opening width for %s',
    async family => {
      const f = fixture({ family });

      await expect(f.validate()).resolves.toMatchObject({
        ok: false, reason: 'OVERSIZE', note: 'MAIN: MAIN exceeds NOA limits.',
      });
    },
  );

  it.each([
    [{ width: '96', doorWidth: '61' }, 'DOOR'],
    [{ width: '82' }, 'SIDELITE'],
    [{ height: '121' }, 'MAIN'],
  ] as const)('still rejects out-of-range dimensions %j for %s', async (overrides, component) => {
    const f = fixture();

    await expect(f.validate(overrides)).resolves.toMatchObject({
      ok: false,
      reason: 'OVERSIZE',
      note: `${component}: ${component} exceeds NOA limits.`,
    });
  });

  it('retains the minimum transom height', async () => {
    const f = fixture();

    await expect(f.validate({ height: '109' })).rejects.toThrow(
      'Transom Height (Opening Height - Door Height) must be at least 10 inches.',
    );
  });

  it('preserves a Pivot Door without a transom', async () => {
    const f = fixture({ hasTransom: false });

    await expect(f.validate({ height: '100', doorHeight: undefined }))
      .resolves.toMatchObject({
        ok: true,
        usedRange: { w: [48, 48], h: [100, 100] },
        note: 'DOOR: OK | SIDELITE: OK',
      });
  });

  it('uses opening width when there are no sidelites and Door Width is omitted', async () => {
    const f = fixture({ sideliteQuantity: 0 });

    await expect(f.validate({ width: '45', doorWidth: undefined }))
      .resolves.toMatchObject({
        ok: true,
        usedRange: { w: [48, 48], h: [120, 120] },
        note: 'DOOR: OK | MAIN: OK',
      });
  });

  it.each([DiagramFamily.PIVOT_DOOR, DiagramFamily.FRENCH_DOOR])(
    'keeps the same family boundary for %s using separately entered sidelite widths',
    async family => {
      const f = fixture({ family, dimensionMode: DimensionMode.ECO_NOVO_DOOR });
      const result = await f.validate({ leftSideliteWidth: '35', leftPanels: 1 });

      if (family === DiagramFamily.PIVOT_DOOR) {
        expect(result).toMatchObject({
          ok: true,
          usedRange: { w: [48, 48], h: [120, 120] },
        });
      } else {
        expect(result).toMatchObject({
          ok: false, reason: 'OVERSIZE', note: 'MAIN: MAIN exceeds NOA limits.',
        });
      }
    },
  );

  it('still requires panel quantity for a separately entered sidelite width', async () => {
    const f = fixture({ dimensionMode: DimensionMode.ECO_NOVO_DOOR });

    await expect(f.validate({ leftSideliteWidth: '35' })).rejects.toThrow(
      'Left Panels is required.',
    );
  });
});
