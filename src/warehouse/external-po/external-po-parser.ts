import { BadRequestException } from '@nestjs/common';
import { MAX_FACTORY_FILE_BYTES, MAX_FACTORY_LINES } from '@/orders/factory-import/factory-import-matching';
import { MAX_PARTS } from '../warehouse-parts';

export type ExternalPoLine = {
  lineNumber: string;
  mark: string;
  description: string;
  panels: number | null;
  family: 'FRENCH_DOOR' | 'SLIDING_DOOR' | 'WINDOW' | 'LINEAR_MATERIAL' | 'UNKNOWN';
  expectedParts: number | null;
  needsReview: boolean;
  issues: string[];
};
export type ExternalPoDocument = {
  poNumber: string;
  orderName: string;
  supplierName: string;
  lines: ExternalPoLine[];
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function text(value: unknown, label: string, max: number) {
  if (value !== undefined && value !== null && typeof value !== 'string')
    throw new BadRequestException(`${label} must be text.`);
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length > max) throw new BadRequestException(`${label} is too long (maximum ${max} characters).`);
  return result;
}

function identifier(value: unknown, label: string) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0))
    throw new BadRequestException(`${label} must be a positive, exact integer.`);
  const result = typeof value === 'number' ? String(value) : text(value, label, 50);
  if (!/^\d{1,50}$/.test(result) || /^0+$/.test(result))
    throw new BadRequestException(`${label} must contain a valid factory number.`);
  return result.replace(/^0+(?=\d)/, '');
}

export function externalProductFamily(description: string): ExternalPoLine['family'] {
  const name = description.split(/\r?\n/, 1)[0];
  const french = /\bfrench\s+door\b/i.test(name);
  const sliding = /\bsliding\s+(?:glass\s+)?door\b/i.test(name);
  if (french && sliding) return 'UNKNOWN';
  if (french) return 'FRENCH_DOOR';
  if (sliding) return 'SLIDING_DOOR';
  if (/\bmullion\b/i.test(name)) return 'LINEAR_MATERIAL';
  if (/\bwindow\b/i.test(name)) return 'WINDOW';
  return 'UNKNOWN';
}

// This parser deliberately never reads financial fields, supplier IDs or product attributes.
export function parseExternalPo(buffer?: Buffer): ExternalPoDocument {
  if (!buffer?.length) throw new BadRequestException('Choose a factory JSON file.');
  if (buffer.length > MAX_FACTORY_FILE_BYTES) throw new BadRequestException('The factory JSON must be 5 MB or smaller.');
  let root: Record<string, unknown>;
  try { root = record(JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''))); }
  catch { throw new BadRequestException('The file is not valid JSON.'); }
  if (root.schema !== 'ews.purchase-order.ai-export.v3')
    throw new BadRequestException('Use a purchase-order JSON export (v3).');
  if (!Array.isArray(root.lines) || !root.lines.length || root.lines.length > MAX_FACTORY_LINES)
    throw new BadRequestException(`The JSON must contain 1 to ${MAX_FACTORY_LINES} factory lines.`);
  const seen = new Set<string>();
  const lines = root.lines.map((raw): ExternalPoLine => {
    const line = record(raw);
    const lineNumber = identifier(line.line_number, 'line_number');
    if (seen.has(lineNumber)) throw new BadRequestException(`Factory line ${lineNumber} appears more than once.`);
    seen.add(lineNumber);
    if (line.qty !== 1) throw new BadRequestException(`Factory line ${lineNumber} must represent exactly one unit (qty: 1).`);
    const description = text(line.description, `Description for ${lineNumber}`, 16000);
    if (!description) throw new BadRequestException(`Factory line ${lineNumber} needs a description.`);
    const family = externalProductFamily(description);
    const rawPanels = record(line.product_details).panels;
    const panels = typeof rawPanels === 'number' && Number.isInteger(rawPanels) && rawPanels > 0 && rawPanels <= MAX_PARTS ? rawPanels : null;
    const issues: string[] = [];
    if (family === 'UNKNOWN') issues.push('Product type is unclear. Review the expected physical parts.');
    if (panels === null) issues.push('A valid panel count is missing. Enter the expected physical parts.');
    const describedPanels = [...description.matchAll(/^\s*panels\s*:\s*(\d+)\s*$/gim)].map((match) => Number(match[1]));
    if (panels !== null && describedPanels.some((count) => count !== panels))
      issues.push('Panel counts in the JSON and description differ. Review the expected physical parts.');
    const calculated = panels === null ? null : panels + (family === 'FRENCH_DOOR' || family === 'SLIDING_DOOR' ? 1 : 0);
    if (calculated !== null && calculated > MAX_PARTS) issues.push(`Expected physical parts cannot exceed ${MAX_PARTS}.`);
    return {
      lineNumber, description, mark: text(line.mark, `Mark for ${lineNumber}`, 200), panels, family,
      expectedParts: issues.length ? null : calculated,
      needsReview: issues.length > 0, issues,
    };
  });
  return {
    poNumber: identifier(root.po_number, 'Factory PO'),
    orderName: text(root.order_name, 'Order name', 200),
    supplierName: text(record(root.supplier).name, 'Supplier name', 200),
    lines,
  };
}
