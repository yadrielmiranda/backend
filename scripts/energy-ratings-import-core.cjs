'use strict';

const SOURCE_PRODUCTS = {
  '50 SINGLE HUNG': ['Eco Windows Systems', '50', 'SINGLE_HUNG'],
  '60 HORIZ. ROLLER': ['Eco Windows Systems', '60', 'HORIZONTAL_SLIDER'],
  '70 PICTURE WINDOW': ['Eco Windows Systems', '70', 'FIXED_SHAPE'],
  '100 SINGLE HUNG': ['Eco Windows Systems', '100', 'SINGLE_HUNG'],
  '150 SINGLE HUNG': ['Eco Windows Systems', '150', 'SINGLE_HUNG'],
  '200 HORIZ. ROLLER': ['Eco Windows Systems', '200', 'HORIZONTAL_SLIDER'],
  '250 HORIZ ROLLER': ['Eco Windows Systems', '250', 'HORIZONTAL_SLIDER'],
  '300 FIXED WINDOW': ['Eco Windows Systems', '300', 'FIXED_SHAPE'],
  '350 FIXED WINDOW': ['Eco Windows Systems', '350', 'FIXED_SHAPE'],
  '400 WINDOW WALL': ['Eco Windows Systems', '400', 'WINDOW_WALL'],
  '450 WINDOW WALL': ['Eco Windows Systems', '450', 'WINDOW_WALL'],
  '500 CASEMENT WDW': ['Eco Windows Systems', '500', 'CASEMENT'],
  '550 FIX CASEMENT': ['Eco Windows Systems', '550', 'CASEMENT'],
  '560 AWNING': ['Eco Windows Systems', '560', 'CASEMENT'],
  '600 FRENCH DOOR': ['Eco Windows Systems', '600', 'FRENCH_DOOR'],
  '700 SLIDING DOOR': ['Eco Windows Systems', '700', 'SLIDING_DOOR'],
  '755 SLIDING DOOR': ['Eco Windows Systems', '755', 'SLIDING_DOOR'],
  '900 BIFOLD DOOR': ['Eco Windows Systems', '900', 'BIFOLD'],
  '1500 PIVOT DOOR': ['Eco Windows Systems', '1500', 'PIVOT_DOOR'],
  '775 SERIES SGD': ['Eco Novo Systems', '775', 'SLIDING_DOOR'],
  '675 SERIES F. DOOR': ['Eco Novo Systems', '675', 'FRENCH_DOOR'],
  '275 SERIES H.ROLLER': ['Eco Novo Systems', '275', 'HORIZONTAL_SLIDER'],
  '175 SERIES S.HUNG': ['Eco Novo Systems', '175', 'SINGLE_HUNG'],
  '375 SERIES P.WDW': ['Eco Novo Systems', '375', 'FIXED_SHAPE'],
  '375 SERIES (SHAPES)': ['Eco Novo Systems', '375', 'FIXED_SHAPE'],
  '575 SERIES CASEMENT': ['Eco Novo Systems', '575', 'CASEMENT'],
  '585 SERIES AWNING': ['Eco Novo Systems', '585', 'CASEMENT'],
  '595 SERIES FIX CASEMENT': ['Eco Novo Systems', '595', 'CASEMENT'],
  '475 WINDOW WALL': ['Eco Novo Systems', '475', 'WINDOW_WALL'],
};
const SHAPE_CONFIGS = new Set(['Tombstone', 'Eyebrow', 'Circle', 'Fan', 'Half Circle', 'Quarter Circle', 'Triangle 90 (Left)', 'Triangle 90 (Right)', 'Trapezoid (Left)', 'Trapezoid (Right)', 'Half Eyebrow (Left)', 'Half Eyebrow (Right)', 'Half Fan (Left)', 'Half Fan (Right)', 'Hexagon', 'Octagon', 'Half Tombstone (Left)', 'Half Tombstone (Right)'].map(normalize));
const KEY_FIELDS = ['idSystem', 'idCrystal', 'idTint', 'idCoating', 'idPrivacy'];

function normalize(value) { return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase(); }
function activeKey(row) { return [...KEY_FIELDS.map(key => row[key]), row.idConfig ?? '*'].join(':'); }
function unique(items, code) { if (items.length !== 1) throw new Error(`${code}:${items.length}`); return items[0]; }
function numeric(value) { return typeof value === 'number' ? Number.isFinite(value) : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()); }

// Remove only the source properties represented by separate catalog selections.
// Ordered plies, treatment, interlayer material/thickness and air/gas remain exact.
function compositionKey(value) {
  const text = normalize(value);
  const core = text.includes('[') ? text.match(/\[([^\]]+)\]/)?.[1] : text;
  if (!core) return null;
  const key = core.replace(/\((?:SB70[^)]*|WHITE[^)]*)\)/g, '')
    .replace(/\b(?:CLEAR|GREY|GRAY|BRONZE|GREEN)\b/g, '')
    .replace(/\bFT\b/g, 'TEMP')
    .replace(/["“”\s]/g, '')
    .replace(/(?:0?\.0*90*)(?=PVB|SGP)/g, '0.09');
  const parts = key.split('+');
  if (!parts.every(part => /^(?:\d+\/\d+|\d*\.\d+)(?:HS|ANN|TEMP|AIR|ARG|PVB|SGP)$/.test(part))) return null;
  return parts.join('+');
}

function sourceOptions(row) {
  const description = normalize(row.glassDescription);
  const composition = normalize(row.composition);
  const descriptionTint = unique([...description.matchAll(/\b(CLEAR|GREY|BRONZE|GREEN)\b/g)].map(match => match[1]), 'SOURCE_TINT_UNCLEAR');
  const colored = [...new Set([...composition.matchAll(/\b(GREY|BRONZE|GREEN)\b/g)].map(match => match[1]))];
  if ((descriptionTint === 'CLEAR' && colored.length) || (descriptionTint !== 'CLEAR' && (colored.length !== 1 || colored[0] !== descriptionTint))) throw new Error('SOURCE_TINT_CONFLICT');
  const privacy = description.includes('PRIVACY');
  if (privacy !== /\(WHITE[^)]*\)/.test(composition)) throw new Error('SOURCE_PRIVACY_CONFLICT');
  const coating = description.includes('SB70');
  if (coating !== composition.includes('SB70')) throw new Error('SOURCE_COATING_CONFLICT');
  const surfaces = [...composition.matchAll(/SB70\s*(?:SURF\s*)?#\s*(\d+)/g)].map(match => Number(match[1]));
  if (coating && (surfaces.length !== 1 || ![2, 4].includes(surfaces[0]))) throw new Error('SOURCE_COATING_SURFACE_UNCLEAR');
  return { tint: descriptionTint, privacy: privacy ? 'WHITE' : 'CLEAR', coating: coating ? 'LOWE SB70' : 'NONE', coatingSurface: surfaces[0] ?? null };
}

function physicalSignature(composition) {
  return normalize(composition)
    .replace(/\(WHITE[^)]*\)/g, '(WHITE)')
    .replace(/\(SB70\s*(?:SURF\s*)?#\s*(\d+)\)/g, '(SB70#$1)')
    .replace(/\bFT\b/g, 'TEMP')
    .replace(/["“”\s]/g, '')
    .replace(/(?:0?\.0*90*)(?=PVB|SGP)/g, '0.09');
}

function sourceSelectionKey(row, options, key) {
  return [normalize(row.brandLabel), normalize(row.productLabel), key, options.tint, options.coating, options.privacy].join('|');
}

function availableOption(catalog, collection, labelField, expected, idBrand, relation, idField) {
  return unique((catalog[collection] || []).filter(item => item.isActive && normalize(item[labelField]) === expected && (catalog[relation] || []).some(link => link.idBrand === idBrand && link[idField] === item.id)), `${collection.toUpperCase()}_UNAVAILABLE_OR_AMBIGUOUS`);
}

function selectSystem(row, catalog) {
  const mapping = SOURCE_PRODUCTS[normalize(row.productLabel)];
  if (!mapping) throw new Error(row.productLabel ? 'SOURCE_PRODUCT_UNMAPPED' : 'SOURCE_PRODUCT_MISSING');
  const [brandName, series, family] = mapping;
  if (normalize(row.brandLabel) !== (brandName === 'Eco Windows Systems' ? 'ECO WINDOW' : 'ECO NOVO')) throw new Error('SOURCE_BRAND_CONFLICT');
  const brand = unique(catalog.brands.filter(item => item.isActive && normalize(item.name) === normalize(brandName)), 'BRAND_UNAVAILABLE_OR_AMBIGUOUS');
  const productIds = new Set(catalog.products.filter(item => item.isActive && item.diagramFamily === family).map(item => item.id));
  return unique(catalog.systems.filter(item => item.isActive && item.idBrand === brand.id && productIds.has(item.idProduct) && normalize(item.name).match(/^SERIE\s+(\d+)(?:\s|$)/)?.[1] === series), 'SYSTEM_UNAVAILABLE_OR_AMBIGUOUS');
}

function selectConfigs(row, system, catalog, scopes, includePendingConfigs = false) {
  const configs = catalog.configs.filter(item => item.isActive && item.idProduct === system.idProduct && catalog.sysConfs.some(link => link.idSystem === system.id && link.idConfig === item.id));
  if (normalize(row.productLabel) === '375 SERIES P.WDW') return [unique(configs.filter(item => normalize(item.conf) === 'PICTURE WINDOW (O)'), 'PICTURE_CONFIG_UNAVAILABLE').id];
  if (normalize(row.productLabel) === '375 SERIES (SHAPES)') {
    const shapes = configs.filter(item => SHAPE_CONFIGS.has(normalize(item.conf)));
    if (!shapes.length) throw new Error('SHAPE_CONFIGS_UNAVAILABLE');
    return shapes.map(item => item.id).sort((a, b) => a - b);
  }
  const scope = scopes?.[normalize(row.productLabel)];
  if (scope?.allConfigs === true && typeof scope.reason === 'string' && scope.reason.trim()) return [null];
  if (Array.isArray(scope?.configNames) && scope.configNames.length && typeof scope.reason === 'string' && scope.reason.trim()) return scope.configNames.map(name => unique(configs.filter(item => normalize(item.conf) === normalize(name)), 'CONFIG_UNAVAILABLE_OR_AMBIGUOUS').id);
  // An exact single available configuration needs no extrapolation to other configurations.
  if (configs.length === 1) return [configs[0].id];
  // User-confirmed series-wide scope for pending rows only; preserve prior imports.
  if (configs.length > 1 && includePendingConfigs === true) return [null];
  throw new Error('CONFIG_SCOPE_REQUIRES_REVIEW');
}

function planImport(source, catalog, options = {}) {
  if (source.formatVersion !== 1 || !Array.isArray(source.rows) || !source.sourceFile || !source.sourceVersion || !source.sourceSheet) throw new Error('Unsupported or incomplete energy source data.');
  const candidates = [];
  const rejected = [];
  // Inspect even unrated source variants. One available value cannot stand in for
  // another physical layer/coating arrangement that the current selectors cannot express.
  const physicalVariants = new Map();
  for (const row of source.rows) {
    try {
      const selections = sourceOptions(row);
      const key = compositionKey(row.composition);
      if (!key) continue;
      const selection = sourceSelectionKey(row, selections, key);
      if (!physicalVariants.has(selection)) physicalVariants.set(selection, new Set());
      physicalVariants.get(selection).add(physicalSignature(row.composition));
    } catch { /* The source validation below reports inconsistent source rows. */ }
  }
  for (const row of source.rows) {
    try {
      if (!Number.isInteger(row.sourceRow) || row.sourceRow <= 0) throw new Error('SOURCE_ROW_INVALID');
      if (!row.productLabel) throw new Error('SOURCE_PRODUCT_MISSING');
      const selections = sourceOptions(row);
      if (!['uFactor', 'shgc', 'vlt'].every(key => numeric(row[key]))) throw new Error('SOURCE_METRICS_MISSING');
      if (Number(row.uFactor) <= 0 || Number(row.shgc) < 0 || Number(row.shgc) > 1 || Number(row.vlt) < 0 || Number(row.vlt) > 1) throw new Error('SOURCE_METRICS_INVALID');
      const system = selectSystem(row, catalog);
      const key = compositionKey(row.composition);
      if (!key) throw new Error('SOURCE_COMPOSITION_INCOMPLETE_OR_UNSUPPORTED');
      if (physicalVariants.get(sourceSelectionKey(row, selections, key)).size !== 1) throw new Error('SOURCE_PHYSICAL_VARIANTS_REQUIRE_REVIEW');
      const crystals = catalog.crystals.filter(item => item.isActive && compositionKey(item.glass) === key && catalog.systemCrystals.some(link => link.idSystem === system.id && link.idCrystal === item.id));
      const crystal = unique(crystals, 'CRYSTAL_UNAVAILABLE_OR_AMBIGUOUS');
      if (!key.includes('AIR') && !key.includes('ARG')) {
        const sourceNominal = row.nominalThickness.replace(/["\s]/g, '');
        const catalogNominal = crystal.glass.match(/^\s*(\d+\/\d+)/)?.[1];
        if (sourceNominal !== catalogNominal) throw new Error('CRYSTAL_NOMINAL_THICKNESS_CONFLICT');
      }
      const tint = availableOption(catalog, 'tints', 'color', selections.tint, system.idBrand, 'brandTints', 'idTint');
      const coating = availableOption(catalog, 'coatings', 'name', selections.coating, system.idBrand, 'brandCoatings', 'idCoating');
      const privacy = availableOption(catalog, 'privacies', 'name', selections.privacy, system.idBrand, 'brandPrivacies', 'idPrivacy');
      const configs = selectConfigs(row, system, catalog, options.configScopes, options.includePendingConfigs);
      for (const idConfig of configs) {
        const data = {
          idSystem: system.id, idCrystal: crystal.id, idTint: tint.id, idCoating: coating.id, idPrivacy: privacy.id, idConfig,
          appliesToAllConfigs: idConfig === null,
          uFactor: Number(row.uFactor).toFixed(6), shgc: Number(row.shgc).toFixed(6), vlt: Number(row.vlt).toFixed(6),
          isActive: true,
        };
        data.activeKey = activeKey(data);
        candidates.push({ data, inputRow: row });
      }
    } catch (error) {
      rejected.push({ ...row, reason: error.message });
    }
  }
  // A lookup must never depend on which Excel row happened to be processed first.
  const counts = new Map();
  for (const { data } of candidates) counts.set(data.activeKey, (counts.get(data.activeKey) || 0) + 1);
  const ready = [];
  const mappedSourceRows = new Set();
  for (const { data, inputRow } of candidates) {
    if (counts.get(data.activeKey) === 1) {
      ready.push(data);
      mappedSourceRows.add(inputRow.sourceRow);
    } else rejected.push({ ...inputRow, reason: 'DUPLICATE_SELECTION_KEY', idConfig: data.idConfig });
  }
  const reasons = {};
  for (const row of rejected) reasons[row.reason] = (reasons[row.reason] || 0) + 1;
  return { summary: { sourceRows: source.rows.length, numericRows: source.rows.filter(row => ['uFactor', 'shgc', 'vlt'].every(key => numeric(row[key]))).length, readyRecords: ready.length, mappedSourceRows: mappedSourceRows.size, rejectedSourceRows: new Set(rejected.map(row => row.sourceRow)).size, reasons }, ready, rejected };
}

module.exports = { planImport, compositionKey, sourceOptions, activeKey, SOURCE_PRODUCTS };
