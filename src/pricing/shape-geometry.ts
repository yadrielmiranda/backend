// src/pricing/shape-geometry.ts
export type DimsFt = {
  width?: number;      // W
  height?: number;     // H
  heightLeft?: number; // H(L)
  heightRight?: number;// H(S)
  legHeight?: number;  // LegH
};

export type ShapeResult = { areaFt2: number; perimeterFt: number };

// ---------- helpers ----------
const N = (x?: number) => (x ?? 0);

// ---------- formas base ----------
function rect(d: DimsFt): ShapeResult {
  const W = N(d.width), H = N(d.height);
  return { areaFt2: W * H, perimeterFt: 2 * (W + H) };
}

function rightTriangle(d: DimsFt): ShapeResult {
  const W = N(d.width), H = N(d.height);
  const hyp = Math.hypot(W, H);
  return { areaFt2: (W * H) / 2, perimeterFt: W + H + hyp };
}

function trapezoid(d: DimsFt): ShapeResult {
  const W = N(d.width), HL = N(d.heightLeft), HR = N(d.heightRight);
  const slanted = Math.hypot(W, HL - HR);
  return { areaFt2: ((HL + HR) / 2) * W, perimeterFt: W + HL + HR + slanted };
}

function circle(d: DimsFt): ShapeResult {
  // aquí W = diámetro
  const D = N(d.width), R = D / 2;
  return { areaFt2: Math.PI * R * R, perimeterFt: Math.PI * D };
}

function halfCircle(d: DimsFt): ShapeResult {
  const D = N(d.width), R = D / 2;
  return { areaFt2: 0.5 * Math.PI * R * R, perimeterFt: D + Math.PI * R };
}

function quarterCircle(d: DimsFt): ShapeResult {
  // en tu UI usas W como radio
  const R = N(d.width);
  return { areaFt2: 0.25 * Math.PI * R * R, perimeterFt: (Math.PI * R) / 2 + 2 * R };
}

function tombstone(d: DimsFt): ShapeResult {
  // completo: arco semicircular sobre rectángulo
  const W = N(d.width), H = N(d.height), R = W / 2;
  const legs = Math.max(0, H - R);
  return { areaFt2: W * legs + 0.5 * Math.PI * R * R, perimeterFt: W + Math.PI * R + 2 * legs };
}

function halfTombstone(d: DimsFt): ShapeResult {
  // Half = mitad vertical de un tombstone completo de ancho 2W y alto H.
  // Entradas: W (ancho de la pieza HALF) y H (alto total).
  const W = N(d.width);
  const H = N(d.height);
  const Rfull = W;                  // radio del tombstone completo (2W de ancho)
  const legsFull = Math.max(0, H - Rfull);     // tramo recto del completo

  // Área: rectángulo W*legsFull + un cuarto de círculo de radio Rfull
  const area = W * legsFull + (Math.PI * Rfull * Rfull) / 4;

  // Perímetro: base W + pata exterior (legsFull) + lado interior (H) + media semicircunferencia
  const perimeter = W + legsFull + H + (Math.PI * Rfull) / 2;

  return { areaFt2: area, perimeterFt: perimeter };
}

function eyebrow(d: DimsFt): ShapeResult {
  const W = N(d.width);
  const H = N(d.height);
  const L = N(d.legHeight); // patas verticales

  if (H <= 0) return { areaFt2: 0, perimeterFt: W + 2 * L };

  // segmento circular (cuerda = W, flecha = H)
  const R = H / 2 + (W * W) / (8 * H);
  const theta = 2 * Math.acos((R - H) / R);
  const arc = R * theta;

  const area = 0.5 * R * R * (theta - Math.sin(theta));
  const perimeter = W + 2 * L + arc; // base + patas + arco

  return { areaFt2: area, perimeterFt: perimeter };
}

function halfEyebrow(d: DimsFt): ShapeResult {
  const W = N(d.width);     // ancho del half
  const H = N(d.height);    // flecha del arco
  const L = N(d.legHeight); // pata exterior

  if (H <= 0) return { areaFt2: 0, perimeterFt: W + L + H };

  // El eyebrow completo que partimos a la mitad tiene cuerda = 2W y la misma flecha H
  const R = H / 2 + ((2 * W) * (2 * W)) / (8 * H); // = H/2 + W^2/(2H)
  const theta = 2 * Math.acos((R - H) / R);

  const arcHalf = (R * theta) / 2;                              // media del arco
  const areaHalf = 0.5 * (0.5 * R * R * (theta - Math.sin(theta))); // mitad del área del segmento

  // Perímetro: base W + pata L + lado interior H + media del arco
  const perimeter = W + L + H + arcHalf;

  return { areaFt2: areaHalf, perimeterFt: perimeter };
}

function fan(d: DimsFt): ShapeResult {
  // segmento circular (sin patas)
  const W = N(d.width), H = N(d.height);
  if (H <= 0) return { areaFt2: 0, perimeterFt: W };
  const R = H / 2 + (W * W) / (8 * H);
  const theta = 2 * Math.acos((R - H) / R);
  const arc = R * theta;
  return { areaFt2: 0.5 * R * R * (theta - Math.sin(theta)), perimeterFt: W + arc };
}

// ---------- mapeo por nombre de config ----------
export type ShapeKey =
  | 'PICTURE'
  | 'TRIANGLE_L' | 'TRIANGLE_R'
  | 'TRAPEZOID_L' | 'TRAPEZOID_R'
  | 'CIRCLE' | 'HALF_CIRCLE' | 'QUARTER_CIRCLE'
  | 'TOMBSTONE' | 'HALF_TOMBSTONE'
  | 'EYEBROW'   | 'HALF_EYEBROW'
  | 'FAN' | 'HALF_FAN_L' | 'HALF_FAN_R';

const shapeFns: Record<ShapeKey, (d: DimsFt) => ShapeResult> = {
  PICTURE: rect,
  TRIANGLE_L: rightTriangle,
  TRIANGLE_R: rightTriangle,
  TRAPEZOID_L: trapezoid,
  TRAPEZOID_R: trapezoid,
  CIRCLE: circle,
  HALF_CIRCLE: halfCircle,
  QUARTER_CIRCLE: quarterCircle,
  TOMBSTONE: tombstone,
  HALF_TOMBSTONE: halfTombstone,
  EYEBROW: eyebrow,
  HALF_EYEBROW: halfEyebrow,
  FAN: fan,
  HALF_FAN_L: fan,
  HALF_FAN_R: fan,
};

export function shapeKeyFromConf(conf: string): ShapeKey {
  const k = (conf || '').toLowerCase();
  if (k.includes('picture')) return 'PICTURE';
  if (k.includes('triangle')) return k.includes('left') ? 'TRIANGLE_L' : 'TRIANGLE_R';
  if (k.includes('trapezoid')) return k.includes('left') ? 'TRAPEZOID_L' : 'TRAPEZOID_R';
  if (k.includes('half circle')) return 'HALF_CIRCLE';
  if (k === 'circle') return 'CIRCLE';
  if (k.includes('quarter')) return 'QUARTER_CIRCLE';
  if (k.includes('half tombstone')) return 'HALF_TOMBSTONE';
  if (k.includes('tombstone')) return 'TOMBSTONE';
  if (k.includes('half eyebrow')) return 'HALF_EYEBROW';
  if (k.includes('eyebrow')) return 'EYEBROW';
  if (k.includes('half fan')) return k.includes('left') ? 'HALF_FAN_L' : 'HALF_FAN_R';
  if (k.includes('fan')) return 'FAN';
  return 'PICTURE';
}

export function areaPerimeterFor(confName: string, dimsFt: DimsFt): ShapeResult {
  const key = shapeKeyFromConf(confName);
  return shapeFns[key](dimsFt);
}
