import { BadRequestException } from '@nestjs/common';
import { FrenchDoorDesignKind, Prisma } from '@prisma/client';
import { DOOR_PRICE, frenchDoorKind } from './door-design-policy';

export type DoorDesignSnapshot = {
  version: 1; id: number; code: string; artworkKey: string; kind: FrenchDoorDesignKind;
  unitPrice: string; systemId: number; configId: number;
};
type Selection = { idDoorDesign?: number | null; doorDesignSnapshot?: unknown };
type PieceContext = { idProd: number; idBrand: number; idSyst: number; idConf?: number };
const trustedPieces = new WeakMap<object, PieceContext & Selection>();

export function rememberDoorDesign(input: object, stored: PieceContext & Selection) {
  trustedPieces.set(input, stored);
}

export function readDoorDesignSnapshot(value: unknown): DoorDesignSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snap = value as DoorDesignSnapshot;
  if (snap.version !== 1 || ![snap.id, snap.systemId, snap.configId].every(id => Number.isSafeInteger(id) && id > 0)
    || typeof snap.code !== 'string' || !snap.code.trim() || typeof snap.artworkKey !== 'string' || !snap.artworkKey.trim()
    || !['SINGLE','DOUBLE'].includes(snap.kind) || typeof snap.unitPrice !== 'string' || !DOOR_PRICE.test(snap.unitPrice)) return null;
  return snap;
}

export function doorDesignContent(piece: Selection) {
  const snap = readDoorDesignSnapshot(piece.doorDesignSnapshot);
  return snap && snap.id === piece.idDoorDesign ? { idDoorDesign: snap.id, doorDesignSnapshot: snap } : {};
}

export function doorDesignPersistence(piece: Selection) {
  const snap = readDoorDesignSnapshot(piece.doorDesignSnapshot);
  if (piece.idDoorDesign != null && (!snap || snap.id !== piece.idDoorDesign)) {
    throw new BadRequestException('The selected door design has not been priced.');
  }
  return { idDoorDesign: piece.idDoorDesign ?? null, doorDesignSnapshot: piece.idDoorDesign != null ? snap as Prisma.InputJsonValue : Prisma.DbNull };
}

export async function resolveDoorDesign(db: Prisma.TransactionClient, input: PieceContext & Selection & { idConf: number; muntin?: { idPattern: number } | null }) {
  const stored = trustedPieces.get(input);
  const samePieceContext = stored && stored.idProd === input.idProd && stored.idBrand === input.idBrand &&
    stored.idSyst === input.idSyst && stored.idConf === input.idConf;
  // Omission from legacy clients preserves the choice; explicit null removes it.
  const id = input.idDoorDesign === undefined && samePieceContext ? stored.idDoorDesign : input.idDoorDesign;
  if (id == null) return { idDoorDesign: null, doorDesignSnapshot: null };
  if (input.muntin) {
    const pattern = await db.muntinPattern.findUnique({ where: { id: input.muntin.idPattern }, select: { inputMode: true } });
    if (pattern?.inputMode !== 'NONE') throw new BadRequestException('Door Design cannot be combined with a muntin.');
  }
  const historic = samePieceContext && stored.idDoorDesign === id ? readDoorDesignSnapshot(stored.doorDesignSnapshot) : null;
  if (historic && historic.id === id && historic.systemId === input.idSyst && historic.configId === input.idConf) {
    return { idDoorDesign: id, doorDesignSnapshot: historic };
  }
  const [context, design] = await Promise.all([
    db.sysConf.findUnique({
      where: { idSystem_idConfig: { idSystem: input.idSyst, idConfig: input.idConf } },
      select: { dimensionMode: true, isSelectableInEstimate: true,
        system: { select: { allowDesign: true, isActive: true, idBrand: true, idProduct: true, brandProduct: { select: { product: { select: { diagramFamily: true, kind: true } } } } } },
        config: { select: { isActive: true, idProduct: true, conf: true } },
      },
    }),
    db.frenchDoorDesign.findUnique({ where: { id } }),
  ]);
  if (!context?.system.allowDesign || design?.unitPrice == null) throw new BadRequestException('This door design is unavailable for this series and configuration.');
  const { system, config, dimensionMode, isSelectableInEstimate } = context;
  const kind = frenchDoorKind(system.brandProduct.product, config.conf, dimensionMode);
  if (kind !== design.kind || system.idBrand !== input.idBrand || system.idProduct !== input.idProd ||
    config.idProduct !== input.idProd || !system.isActive || !config.isActive || !isSelectableInEstimate) {
    throw new BadRequestException('This design does not match the selected door.');
  }
  const { code, artworkKey, unitPrice } = design;
  const snapshot: DoorDesignSnapshot = {
    version: 1, id, code, artworkKey, kind, unitPrice: unitPrice.toFixed(2), systemId: input.idSyst, configId: input.idConf,
  };
  return { idDoorDesign: id, doorDesignSnapshot: snapshot };
}
