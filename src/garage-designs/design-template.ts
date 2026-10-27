import { registerDecorator, ValidationOptions } from 'class-validator';

export type GarageDesignMaterial = 'slat' | 'glass';

/** A declarative grid of relative dimensions; it never contains executable SVG. */
export type GarageDesignTemplate = {
  version: 1;
  columns: number[];
  rows: number[];
  cells: GarageDesignMaterial[][];
};

const MAX_GRID_DIMENSION = 12;
const MAX_GRID_CELLS = 144;
const SUM_TOLERANCE = 1e-6;
const TEMPLATE_KEYS = new Set(['version', 'columns', 'rows', 'cells']);

function readRelativeDimensions(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_GRID_DIMENSION) return null;
  let sum = 0;
  for (let index = 0; index < value.length; index++) {
    const dimension = value[index];
    if (typeof dimension !== 'number' || !Number.isFinite(dimension) || dimension <= 0) return null;
    sum += dimension;
  }
  // Include only the arithmetic noise of adding the finite dimensions.
  if (Math.abs(sum - 1) > SUM_TOLERANCE + Number.EPSILON * value.length) return null;
  return [...value];
}

/** Returns a canonical, independent copy, or null for absent/invalid templates. */
export function readGarageDesignTemplate(value: unknown): GarageDesignTemplate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== TEMPLATE_KEYS.size || keys.some(key => !TEMPLATE_KEYS.has(key)) || input.version !== 1) return null;
  const columns = readRelativeDimensions(input.columns);
  const rows = readRelativeDimensions(input.rows);
  if (!columns || !rows || columns.length * rows.length > MAX_GRID_CELLS ||
    !Array.isArray(input.cells) || input.cells.length !== rows.length) return null;

  const cells: GarageDesignMaterial[][] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = input.cells[rowIndex];
    if (!Array.isArray(row) || row.length !== columns.length) return null;
    const materials: GarageDesignMaterial[] = [];
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const material = row[columnIndex];
      if (material !== 'slat' && material !== 'glass') return null;
      materials.push(material);
    }
    cells.push(materials);
  }
  return { version: 1, columns, rows, cells };
}

/** Missing or malformed geometry cannot establish whether a design contains glass. */
export function garageDesignHasGlass(value: unknown): boolean | null {
  const template = readGarageDesignTemplate(value);
  return template ? template.cells.some(row => row.includes('glass')) : null;
}

export function IsGarageDesignTemplate(options?: ValidationOptions) {
  return (object: object, propertyName: string) => registerDecorator({
    name: 'isGarageDesignTemplate', target: object.constructor, propertyName,
    options: {
      message: 'Template must use version 1, 1–12 positive row and column weights summing to 1, and matching slat/glass cells.',
      ...options,
    },
    validator: { validate: value => readGarageDesignTemplate(value) !== null },
  });
}
