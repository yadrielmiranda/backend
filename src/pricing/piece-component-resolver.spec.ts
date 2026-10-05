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
  it.each([undefined, null])('resolves an Eco Novo door and right sidelite without a persisted opening width (%s)', (width) => {
    const result = resolvePieceComponents({
      idSystem: 16,
      idConfig: 201,
      configName: 'XO',
      dimensionMode: DimensionMode.ECO_NOVO_DOOR,
      pricingComponents: [
        component(PricingComponentType.DOOR, 12, 'Single door'),
        component(PricingComponentType.SIDELITE, 13, 'Sidelite'),
      ],
      width,
      height: 80,
      doorWidth: 41,
      rightSideliteWidth: 14,
      rightPanels: 1,
    });

    expect(result.map(({ idConfig, widthIn, heightIn }) => ({ idConfig, widthIn, heightIn }))).toEqual([
      { idConfig: 12, widthIn: 41, heightIn: 80 },
      { idConfig: 13, widthIn: 14, heightIn: 80 },
    ]);
  });

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

  it.each([108, undefined, null])('keeps Eco Novo sides separate and repeats their real panel counts (opening width %s)', (width) => {
    const result = resolvePieceComponents({
      idSystem: 16,
      idConfig: 201,
      configName: 'composite',
      dimensionMode: DimensionMode.ECO_NOVO_DOOR,
      pricingComponents: [
        component(PricingComponentType.DOOR, 12, 'Door source'),
        component(PricingComponentType.SIDELITE, 13, 'Sidelite source'),
      ],
      width,
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

  it.each([
    { dimensions: { height: null }, error: 'Opening Height is required.' },
    { dimensions: { height: 0 }, error: 'Opening Height must be greater than zero.' },
    { dimensions: { doorWidth: null }, error: 'Door Width is required.' },
    { dimensions: { doorWidth: -1 }, error: 'Door Width must be greater than zero.' },
    { dimensions: { rightSideliteWidth: null }, error: 'Right Sidelite Width is required.' },
    { dimensions: { rightSideliteWidth: 0 }, error: 'Right Sidelite Width must be greater than zero.' },
    { dimensions: { rightPanels: null }, error: 'Right Sidelite Qty must be a whole number greater than zero.' },
    { dimensions: { rightPanels: 0 }, error: 'Right Sidelite Qty must be a whole number greater than zero.' },
    { dimensions: { rightPanels: 1.5 }, error: 'Right Sidelite Qty must be a whole number greater than zero.' },
    { dimensions: { leftSideliteWidth: -1, leftPanels: 1 }, error: 'Left Sidelite Width must be greater than zero.' },
    { dimensions: { leftSideliteWidth: 12, leftPanels: 0 }, error: 'Left Sidelite Qty must be a whole number greater than zero.' },
    { dimensions: { rightSideliteWidth: null, rightPanels: null }, error: 'At least one sidelite panel is required for component pricing.' },
  ])('still rejects invalid Eco Novo component dimensions: $error', ({ dimensions, error }) => {
    expect(() => resolvePieceComponents({
      idSystem: 16,
      idConfig: 201,
      configName: 'XO',
      dimensionMode: DimensionMode.ECO_NOVO_DOOR,
      pricingComponents: [
        component(PricingComponentType.DOOR, 12, 'Single door'),
        component(PricingComponentType.SIDELITE, 13, 'Sidelite'),
      ],
      width: null,
      height: 80,
      doorWidth: 41,
      rightSideliteWidth: 14,
      rightPanels: 1,
      ...dimensions,
    })).toThrow(error);
  });

  it.each([undefined, null, 0, -1, Infinity])('still requires a valid Eco Windows opening width (%s)', (width) => {
    expect(() => resolvePieceComponents({
      idSystem: 15,
      idConfig: 200,
      configName: 'XO',
      dimensionMode: DimensionMode.ECO_WINDOWS_DOOR,
      pricingComponents: [
        component(PricingComponentType.DOOR, 10, 'Door'),
        component(PricingComponentType.SIDELITE, 11, 'Sidelite', 1),
      ],
      width,
      height: 80,
      doorWidth: 41,
    })).toThrow('Opening Width');
  });

  it.each([40, 41])('still rejects Eco Windows sidelites without remaining opening width (%s)', (width) => {
    expect(() => resolvePieceComponents({
      idSystem: 15,
      idConfig: 200,
      configName: 'XO',
      dimensionMode: DimensionMode.ECO_WINDOWS_DOOR,
      pricingComponents: [
        component(PricingComponentType.DOOR, 10, 'Door'),
        component(PricingComponentType.SIDELITE, 11, 'Sidelite', 1),
      ],
      width,
      height: 80,
      doorWidth: 41,
    })).toThrow('Opening Width must be greater than Door Width when sidelites are used.');
  });

  it('continues using the opening width for an Eco Windows door without sidelites', () => {
    const result = resolvePieceComponents({
      idSystem: 15,
      idConfig: 200,
      configName: 'X',
      dimensionMode: DimensionMode.ECO_WINDOWS_DOOR,
      pricingComponents: [component(PricingComponentType.DOOR, 10, 'Door')],
      width: 41,
      height: 80,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ widthIn: 41, heightIn: 80 });
  });
});
