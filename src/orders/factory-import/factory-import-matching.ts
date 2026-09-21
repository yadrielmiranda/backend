import { BadRequestException } from '@nestjs/common';
import Decimal from 'decimal.js';

export const MAX_FACTORY_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FACTORY_LINES = 5000;

export type FactoryLine = {
  lineNumber: string;
  panels?: number | null;
  mark: string;
  description: string;
  size: string;
  width: number | null;
  height: number | null;
  configurationId: string;
  panelConfig: string;
  frameColor: string;
};
export type FactoryDocument = {
  poNumber: string;
  factoryCost: string;
  orderName: string;
  lines: FactoryLine[];
};
export type LocalFactoryPiece = {
  id: number;
  mark: string;
  qty: number;
  brand: string;
  product: string;
  family: string;
  system: string;
  configuration: string;
  frameColor: string;
  width: number | null;
  height: number | null;
  active: string;
  complexDimensions: boolean;
  matchKey: string;
  lineNumbers: string[];
  panelCount?: number | null;
  fixedPanelCount?: number | null;
};
export type FactoryAssignment = { lineNumber: string; pieceId: number };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) =>
  typeof value === 'string' ? value.trim() : '';
export const normalizedMark = (value: string) => value.trim().toUpperCase();
const token = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;

// Lee el literal del importe sin convertirlo primero a un Number binario.
function costLiteral(json: string): string | null {
  let depth = 0;
  let result: string | null = null;
  for (let index = 0; index < json.length; index++) {
    const character = json[index];
    if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') depth--;
    else if (character === '"') {
      const start = index;
      while (++index < json.length) {
        if (json[index] === '\\') index++;
        else if (json[index] === '"') break;
      }
      if (
        depth !== 1 ||
        JSON.parse(json.slice(start, index + 1)) !== 'discounted_total'
      )
        continue;
      if (!/^\s*:/.test(json.slice(index + 1))) continue;
      const rest = json
        .slice(index + 1)
        .match(/^\s*:\s*("(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
      if (!rest || result !== null)
        throw new BadRequestException('Invalid or duplicate discounted_total.');
      result = rest[1].startsWith('"') ? JSON.parse(rest[1]) : rest[1];
    }
  }
  return result;
}

function identifier(value: unknown, name: string): string {
  if (
    typeof value === 'number' &&
    (!Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new BadRequestException(`${name} must be a positive, exact integer.`);
  }
  const result = typeof value === 'number' ? String(value) : text(value);
  if (!/^\d{1,50}$/.test(result) || /^0+$/.test(result)) {
    throw new BadRequestException(
      `${name} must contain a valid factory number.`,
    );
  }
  return result.replace(/^0+(?=\d)/, '');
}

// Se conserva la fracción original: product_details puede truncar las pulgadas.
export function inches(value: string): number | null {
  const source = value
    .trim()
    .replace(/["″]/g, '')
    .replace(/(\d)-(\d+\/\d+)/g, '$1 $2');
  if (/^\d+(?:\.\d+)?$/.test(source)) return Number(source);
  const fraction = source.match(/^(?:(\d+)\s+)?(\d+)\/(\d+)$/);
  if (!fraction || Number(fraction[3]) === 0) return null;
  return Number(fraction[1] ?? 0) + Number(fraction[2]) / Number(fraction[3]);
}

export function parseFactoryDocument(buffer?: Buffer): FactoryDocument {
  if (!buffer?.length)
    throw new BadRequestException('Choose a factory JSON file.');
  if (buffer.length > MAX_FACTORY_FILE_BYTES)
    throw new BadRequestException('The factory JSON must be 5 MB or smaller.');
  let root: Record<string, unknown>;
  const json = buffer.toString('utf8').replace(/^\uFEFF/, '');
  try {
    root = record(JSON.parse(json));
  } catch {
    throw new BadRequestException('The file is not valid JSON.');
  }
  if (
    root.schema !== 'ews.purchase-order.ai-export.v3' ||
    token(text(record(root.supplier).id)) !== 'ECO'
  ) {
    throw new BadRequestException(
      'Use an ECO Window Systems purchase-order JSON export (v3).',
    );
  }
  if (root.currency !== 'USD')
    throw new BadRequestException('The factory order must use USD.');
  const poNumber = identifier(root.po_number, 'Factory PO');
  const rawCost = costLiteral(json);
  if (rawCost === null || !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(rawCost)) {
    throw new BadRequestException(
      'discounted_total must be a nonnegative amount with up to 8 decimal places.',
    );
  }
  const cost = new Decimal(rawCost);
  if (
    !cost.isFinite() ||
    cost.lt(0) ||
    cost.gte('10000000000') ||
    cost.decimalPlaces() > 8
  )
    throw new BadRequestException(
      'Invalid factory cost (maximum 8 decimal places).',
    );
  if (
    !Array.isArray(root.lines) ||
    !root.lines.length ||
    root.lines.length > MAX_FACTORY_LINES
  ) {
    throw new BadRequestException(
      `The JSON must contain 1 to ${MAX_FACTORY_LINES} factory lines.`,
    );
  }
  const seen = new Set<string>();
  const lines = root.lines.map((value, index): FactoryLine => {
    const line = record(value);
    const lineNumber = identifier(
      line.line_number,
      `Line ${index + 1}: line_number`,
    );
    if (seen.has(lineNumber))
      throw new BadRequestException(
        `Factory line ${lineNumber} appears more than once.`,
      );
    seen.add(lineNumber);
    if (line.qty !== 1)
      throw new BadRequestException(
        `Factory line ${lineNumber} must represent one unit (qty 1), with its own line_number.`,
      );
    const rawDescription = text(line.description);
    if (
      !rawDescription ||
      rawDescription.length > 20000 ||
      text(line.mark).length > 200
    ) {
      throw new BadRequestException(
        `Factory line ${lineNumber} has an invalid description or mark.`,
      );
    }
    const details = record(line.product_details);
    const size =
      rawDescription.match(/^\s*Size\s*:\s*([^\r\n]+)/im)?.[1]?.trim() ?? '';
    const dimensions = size.split(/\s*[x×]\s*/i);
    return {
      lineNumber,
      panels:
        Number.isInteger(details.panels) &&
        Number(details.panels) > 0 &&
        Number(details.panels) < 200
          ? Number(details.panels)
          : null,
      mark: text(line.mark),
      description: rawDescription.split(/\r?\n/)[0].slice(0, 500),
      size,
      width: size
        ? dimensions.length === 2
          ? inches(dimensions[0])
          : null
        : finite(details.width_in),
      height: size
        ? dimensions.length === 2
          ? inches(dimensions[1])
          : null
        : finite(details.height_in),
      configurationId: text(details.configuration_id).slice(0, 100),
      panelConfig: text(details.panel_config).slice(0, 100),
      frameColor: text(details.frame_color).slice(0, 100),
    };
  });
  // Los demás campos del archivo no salen del analizador ni se persisten.
  return {
    poNumber,
    factoryCost: cost.toFixed(),
    orderName: text(root.order_name).slice(0, 200),
    lines,
  };
}

function family(description: string) {
  const source = description.toUpperCase();
  if (/MULLION|ALUMINUM TUBE/.test(source)) return 'LINEAR_MATERIAL';
  if (/HORIZONTAL (ROLLING|SLIDING)/.test(source)) return 'HORIZONTAL_SLIDER';
  if (/SLIDING.*DOOR/.test(source)) return 'SLIDING_DOOR';
  if (/FRENCH DOOR/.test(source)) return 'FRENCH_DOOR';
  if (/SINGLE HUNG/.test(source)) return 'SINGLE_HUNG';
  if (/WINDOW WALL/.test(source)) return 'WINDOW_WALL';
  if (/FIXED|PICTURE WINDOW|HALF CIRCLE/.test(source)) return 'FIXED_SHAPE';
  if (/CASEMENT/.test(source)) return 'CASEMENT';
  if (/PIVOT/.test(source)) return 'PIVOT_DOOR';
  if (/BI.?FOLD/.test(source)) return 'BIFOLD';
  if (/GARAGE/.test(source)) return 'GARAGE_DOOR';
  return '';
}

function configurationMatches(line: FactoryLine, piece: LocalFactoryPiece) {
  const config = token(piece.configuration);
  if (!config) return false;
  if (
    config === token(line.configurationId) ||
    config === token(line.panelConfig)
  )
    return true;
  const description = token(line.description);
  const aliases: Record<string, string[]> = {
    PW: ['PICTUREWINDOW'],
    PICTURE: ['PICTUREWINDOW'],
    PICTUREWINDOW: ['PICTUREWINDOW'],
    HC: ['HALFCIRCLE'],
    HALFCIRCLE: ['HALFCIRCLE'],
    EL: ['EQUALLITES'],
    EQUALLITES: ['EQUALLITES'],
  };
  if ((aliases[config] ?? []).some((alias) => description.includes(alias)))
    return true;
  // Los códigos cortos deben coincidir como palabra, para distinguir O de OX.
  if (config.length <= 3 || /^\d+X\d+$/.test(config)) {
    return line.description
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .includes(config);
  }
  return description.includes(config);
}

export function matchingIssues(
  line: FactoryLine,
  piece: LocalFactoryPiece,
): string[] {
  const issues: string[] = [];
  if (
    !normalizedMark(line.mark) ||
    normalizedMark(line.mark) !== normalizedMark(piece.mark)
  )
    issues.push('Mark differs or is missing');
  if (!/\bECO\b/i.test(piece.brand)) issues.push('Brand needs review');
  const factoryFamily = family(line.description);
  const localFamily =
    piece.family === 'GENERIC' ? family(piece.product) : piece.family;
  if (!factoryFamily || factoryFamily !== localFamily)
    issues.push('Product needs review');
  const factorySeries = line.description.match(/\b\d{3,4}\b/)?.[0];
  const localSeries = piece.system.match(/\b\d{3,4}\b/)?.[0];
  if (
    !(factorySeries && factorySeries === localSeries) &&
    !(
      token(piece.system).length >= 2 &&
      token(line.description).includes(token(piece.system))
    )
  )
    issues.push('System needs review');
  if (!configurationMatches(line, piece))
    issues.push('Configuration needs review');
  const same = (a: number | null, b: number | null) =>
    a !== null && b !== null && Math.abs(a - b) < 0.001;
  if (
    !same(line.width, piece.width) ||
    !same(line.height, piece.height ?? 0) ||
    piece.complexDimensions
  )
    issues.push('Dimensions need review');
  const color = token(piece.frameColor);
  if (
    !color ||
    (line.frameColor
      ? color !== token(line.frameColor)
      : !token(line.description).includes(color))
  )
    issues.push('Frame color needs review');
  const factoryActive = line.description
    .match(/\b(Left|Right) Active\b/i)?.[1]
    ?.toUpperCase();
  const localActive = piece.active
    .match(/\b(Left|Right)\b/i)?.[1]
    ?.toUpperCase();
  if ((factoryActive || localActive) && factoryActive !== localActive)
    issues.push('Active side needs review');
  return issues;
}

export function matchFactoryLines(
  document: FactoryDocument,
  pieces: LocalFactoryPiece[],
) {
  const assigned = new Map(
    pieces.map((piece) => [piece.id, piece.lineNumbers.length]),
  );
  const existing = new Map(
    pieces.flatMap((piece) =>
      piece.lineNumbers.map((number) => [number, piece.id] as const),
    ),
  );
  return document.lines.map((line) => {
    const linked = existing.get(line.lineNumber);
    if (linked)
      return {
        ...line,
        pieceId: linked,
        existing: true,
        issues: matchingIssues(line, pieces.find((p) => p.id === linked)!),
      };
    const candidates = pieces.filter(
      (piece) =>
        (assigned.get(piece.id) ?? 0) < piece.qty &&
        matchingIssues(line, piece).length === 0,
    );
    // Varias filas idénticas son intercambiables: se consume su capacidad en orden estable.
    const compatible =
      new Set(candidates.map((piece) => piece.matchKey)).size === 1;
    const chosen = compatible ? candidates[0] : undefined;
    if (chosen) assigned.set(chosen.id, (assigned.get(chosen.id) ?? 0) + 1);
    return {
      ...line,
      pieceId: chosen?.id ?? null,
      existing: false,
      issues: chosen
        ? []
        : [
            candidates.length
              ? 'Several different pieces match. Select a piece.'
              : 'Select a piece to review this factory line.',
          ],
    };
  });
}
