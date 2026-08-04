import {
  DimensionMode,
  PricingComponentType,
} from '@prisma/client';
import { resolvePieceComponents } from './piece-component-resolver';

const component = (
  componentType: PricingComponentType,
  sourceConfigId: number,
  name: string,
  quantity: number | null = null,
) => ({
  componentType,
  sourceConfigId,
  quantity,
  sourceSysConf: { config: { conf: name } },
});

describe('resolvePieceComponents', () => {
  it('keeps every direct configuration as one unit without interpreting its name', () => {
    const result = resolvePieceComponents({
      idSystem: 7,
      idConfig: 91,
      configName: 'XXT',
      dimensionMode: DimensionMode.ECO_WINDOWS_DOOR,
      pricingComponents: [],
      width: 72,
      height: 120,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      idConfig: 91,
      configName: 'XXT',
      componentType: null,
      widthIn: 72,
      heightIn: 120,
    });
  });

  it('uses configured Eco Windows sources and quantity', () => {
    const result = resolvePieceComponents({
      idSystem: 15,
      idConfig: 200,
      configName: 'any composite label',
      dimensionMode: DimensionMode.ECO_WINDOWS_DOOR,
      pricingComponents: [
        component(PricingComponentType.DOOR, 10, 'Direct door'),
        component(PricingComponentType.SIDELITE, 11, 'Direct sidelite', 2),
      ],
      width: 100,
      height: 96,
      doorWidth: 64,
    });

    expect(result.map((item) => item.idConfig)).toEqual([10, 11, 11]);
    expect(result.map((item) => item.widthIn)).toEqual([64, 18, 18]);
  });

  it('keeps Eco Novo sides separate and repeats their real panel counts', () => {
    const result = resolvePieceComponents({
      idSystem: 16,
      idConfig: 201,
      configName: 'composite',
      dimensionMode: DimensionMode.ECO_NOVO_DOOR,
      pricingComponents: [
        component(PricingComponentType.DOOR, 12, 'Door source'),
        component(PricingComponentType.SIDELITE, 13, 'Sidelite source'),
      ],
      width: 108,
      height: 100,
      doorWidth: 60,
      leftSideliteWidth: 12,
      leftPanels: 1,
      rightSideliteWidth: 18,
      rightPanels: 2,
    });

    expect(result.map((item) => item.widthIn)).toEqual([60, 12, 18, 18]);
    expect(result.map((item) => item.componentLabel)).toEqual([
      'Door source',
      'Sidelite source (Left 1)',
      'Sidelite source (Right 1)',
      'Sidelite source (Right 2)',
    ]);
  });
});
