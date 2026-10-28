import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { garageDesignHasGlass, readGarageDesignTemplate, type GarageDesignTemplate } from '@/garage-designs/design-template';

export type PieceDesignSnapshot = {
  version: 1;
  systemId: number;
  design: { id: number; name: string; imageUrl: string | null; template?: GarageDesignTemplate };
  color: { id: number; name: string; hexCode: string; idFrameColor?: number };
};

type DesignInput = {
  idProd: number;
  idBrand: number;
  idSyst: number;
  idDesign?: number | null;
  idDesignColor?: number | null;
  idFC?: number;
  frameColorBeforeDesignId?: number | null;
};

async function linkedFrameColor(db: Prisma.TransactionClient, idSystem: number, idFrameColor: number | null | undefined) {
  if (!Number.isSafeInteger(idFrameColor) || Number(idFrameColor) <= 0) {
    throw new BadRequestException('Link this design color to a Frame Color in Garage Designs before using it.');
  }
  const association = await db.systemFrameColor.findUnique({
    where: { idSystem_idFrameColor: { idSystem, idFrameColor: idFrameColor! } },
    include: { frameColor: { select: { isActive: true } } },
  });
  if (!association?.frameColor.isActive) {
    throw new BadRequestException('The frame color linked to this design color must be active and available for the selected system.');
  }
  return idFrameColor!;
}

type StoredDesign = DesignInput & { designSnapshot?: unknown };
const storedDesigns = new WeakMap<object, StoredDesign>();

async function previousFrameColor(db: Prisma.TransactionClient, input: DesignInput, stored?: StoredDesign) {
  // An omitted field from an older editor preserves saved memory. Existing
  // design-linked idFC is never evidence of the frame chosen before the design.
  const id = input.frameColorBeforeDesignId !== undefined
    ? input.frameColorBeforeDesignId
    : stored?.idDesign || stored?.idDesignColor
      ? stored.frameColorBeforeDesignId
      : stored?.idFC;
  if (id == null) return null;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new BadRequestException('The previous frame color must be a valid color ID.');
  }
  // Inactive colors may be remembered; availability is checked when restoring.
  // Deleted colors (including old revision JSON) simply use the UI fallback.
  const color = await db.frameColor.findUnique({ where: { id }, select: { id: true } });
  return color ? id : null;
}

/** Only authenticated server workflows may attach a previously saved selection. */
export function withStoredPieceDesign<T extends DesignInput>(input: T, stored?: StoredDesign | null): T {
  if (stored) storedDesigns.set(input, stored);
  return input;
}

export function readPieceDesignSnapshot(value: unknown): PieceDesignSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as PieceDesignSnapshot;
  if (snapshot.version !== 1 || !Number.isSafeInteger(snapshot.systemId) ||
      !Number.isSafeInteger(snapshot.design?.id) || !Number.isSafeInteger(snapshot.color?.id) ||
      typeof snapshot.design?.name !== 'string' ||
      typeof snapshot.color?.name !== 'string' || typeof snapshot.color?.hexCode !== 'string') return null;
  return snapshot;
}

/** Only matching, captured all-slat geometry suppresses glass information. */
export function pieceHasSolidGarageDesign(piece: {
  idSyst?: number | null;
  idDesign?: number | null;
  idDesignColor?: number | null;
  designSnapshot?: unknown;
}): boolean {
  const snapshot = readPieceDesignSnapshot(piece.designSnapshot);
  return Boolean(snapshot && Number.isSafeInteger(piece.idSyst) && Number(piece.idSyst) > 0 &&
    Number.isSafeInteger(piece.idDesign) && Number(piece.idDesign) > 0 &&
    Number.isSafeInteger(piece.idDesignColor) && Number(piece.idDesignColor) > 0 &&
    snapshot.systemId === piece.idSyst && snapshot.design.id === piece.idDesign &&
    snapshot.color.id === piece.idDesignColor && garageDesignHasGlass(snapshot.design.template) === false);
}

export async function resolvePieceDesign(db: Prisma.TransactionClient, input: DesignInput) {
  const stored = storedDesigns.get(input);
  const sameSystem = stored && stored.idProd === input.idProd &&
    stored.idBrand === input.idBrand && stored.idSyst === input.idSyst;
  // Older clients omit these fields. An explicit null pair removes the design.
  const omitted = input.idDesign === undefined && input.idDesignColor === undefined;
  const idDesign = (omitted && sameSystem ? stored.idDesign : input.idDesign) ?? null;
  const idDesignColor = (omitted && sameSystem ? stored.idDesignColor : input.idDesignColor) ?? null;
  if (idDesign === null && idDesignColor === null) {
    return { idDesign: null, idDesignColor: null, designSnapshot: null, frameColorBeforeDesignId: null };
  }
  if (!Number.isSafeInteger(idDesign) || Number(idDesign) <= 0 ||
      !Number.isSafeInteger(idDesignColor) || Number(idDesignColor) <= 0) {
    throw new BadRequestException('Choose both a design and a design color.');
  }

  const historical = sameSystem ? readPieceDesignSnapshot(stored.designSnapshot) : null;
  const frameColorBeforeDesignId = await previousFrameColor(db, input, sameSystem ? stored : undefined);
  if (historical && stored.idDesign === idDesign && stored.idDesignColor === idDesignColor &&
      historical.systemId === input.idSyst && historical.design.id === idDesign &&
      historical.color.id === idDesignColor) {
    const mappedFrame = historical.color.idFrameColor ?? (await db.designColor.findUnique({
      where: { id: idDesignColor! }, select: { idFrameColor: true },
    }))?.idFrameColor;
    const idFC = await linkedFrameColor(db, input.idSyst, mappedFrame);
    return { idDesign, idDesignColor, idFC, frameColorBeforeDesignId,
      designSnapshot: { ...historical, color: { ...historical.color, idFrameColor: idFC } } };
  }

  const option = await db.systemDesignOption.findUnique({
    where: { idSystem_idDesign_idDesignColor: { idSystem: input.idSyst, idDesign: idDesign!, idDesignColor: idDesignColor! } },
    include: { design: true, color: true, system: { include: { brandProduct: { include: { product: true } } } } },
  });
  if (!option || !option.system.allowDesign || !option.system.isActive ||
      option.system.idBrand !== input.idBrand || option.system.idProduct !== input.idProd ||
      option.system.brandProduct.product.diagramFamily !== 'GARAGE_DOOR' ||
      !option.design.isActive || !option.color.isActive) {
    throw new BadRequestException('The selected design and color are not available for this system.');
  }

  const template = readGarageDesignTemplate(option.design.template);
  const idFC = await linkedFrameColor(db, input.idSyst, option.color.idFrameColor);
  const designSnapshot: PieceDesignSnapshot = {
    version: 1,
    systemId: input.idSyst,
    design: { id: option.design.id, name: option.design.name, imageUrl: option.design.imageUrl, ...(template ? { template } : {}) },
    color: { id: option.color.id, name: option.color.name, hexCode: option.color.hexCode, idFrameColor: idFC },
  };
  return { idDesign, idDesignColor, idFC, designSnapshot, frameColorBeforeDesignId };
}

export function pieceDesignPersistence(piece: { idDesign?: number | null; idDesignColor?: number | null; designSnapshot?: unknown; frameColorBeforeDesignId?: number | null }) {
  return {
    idDesign: piece.idDesign ?? null,
    idDesignColor: piece.idDesignColor ?? null,
    frameColorBeforeDesignId: piece.idDesign && piece.idDesignColor ? piece.frameColorBeforeDesignId ?? null : null,
    designSnapshot: piece.idDesign && piece.idDesignColor && readPieceDesignSnapshot(piece.designSnapshot)
      ? piece.designSnapshot as Prisma.InputJsonValue : Prisma.DbNull,
  };
}

/** Keep pre-design documents' fingerprints unchanged. */
export function pieceDesignContent(piece: { idDesign?: number | null; idDesignColor?: number | null; designSnapshot?: unknown }) {
  return piece.idDesign || piece.idDesignColor ? {
    idDesign: piece.idDesign ?? null,
    idDesignColor: piece.idDesignColor ?? null,
    designSnapshot: readPieceDesignSnapshot(piece.designSnapshot),
  } : {};
}
