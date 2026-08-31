import { DimensionMode } from '@prisma/client';

import { PrismaService } from '@/prisma/prisma.service';

export type EstimatePieceDiagramMetadata = {
  dimensionMode: DimensionMode;
  hasCoating: boolean;
  hasPrivacy: boolean;
};

type DiagramPieceInput = {
  idSyst: number;
  idConf: number;
  idBrand: number;
  idCoat: number | null;
  idPrivacy: number | null;
};

function uniquePairs<T>(values: T[], keyFor: (value: T) => string) {
  return Array.from(
    new Map(values.map((value) => [keyFor(value), value])).values(),
  );
}

/**
 * Agrega solo los indicadores que necesita el render del diagrama.
 * No expone costos ni obliga a duplicar reglas visuales en el frontend.
 */
export async function attachEstimatePieceDiagramMetadata<
  T extends DiagramPieceInput,
>(prisma: PrismaService, pieces: T[]) {
  if (pieces.length === 0) {
    return [] as Array<T & { diagramMetadata: EstimatePieceDiagramMetadata }>;
  }

  const sysConfPairs = uniquePairs(
    pieces.map((piece) => ({
      idSystem: piece.idSyst,
      idConfig: piece.idConf,
    })),
    (value) => `${value.idSystem}:${value.idConfig}`,
  );
  const coatingPairs = uniquePairs(
    pieces
      .filter((piece) => piece.idCoat != null)
      .map((piece) => ({
        idBrand: piece.idBrand,
        idCoating: piece.idCoat as number,
      })),
    (value) => `${value.idBrand}:${value.idCoating}`,
  );
  const privacyPairs = uniquePairs(
    pieces
      .filter((piece) => piece.idPrivacy != null)
      .map((piece) => ({
        idBrand: piece.idBrand,
        idPrivacy: piece.idPrivacy as number,
      })),
    (value) => `${value.idBrand}:${value.idPrivacy}`,
  );

  const [sysConfs, brandCoatings, brandPrivacies] = await Promise.all([
    prisma.sysConf.findMany({
      where: { OR: sysConfPairs },
      select: {
        idSystem: true,
        idConfig: true,
        dimensionMode: true,
      },
    }),
    coatingPairs.length > 0
      ? prisma.brandCoating.findMany({
          where: { OR: coatingPairs },
          select: {
            idBrand: true,
            idCoating: true,
            surchargeEnabled: true,
          },
        })
      : Promise.resolve([]),
    privacyPairs.length > 0
      ? prisma.brandPrivacy.findMany({
          where: { OR: privacyPairs },
          select: {
            idBrand: true,
            idPrivacy: true,
            surchargeEnabled: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const dimensionModeBySysConf = new Map(
    sysConfs.map((sysConf) => [
      `${sysConf.idSystem}:${sysConf.idConfig}`,
      sysConf.dimensionMode,
    ]),
  );
  const coatingEnabledByBrand = new Map(
    brandCoatings.map((association) => [
      `${association.idBrand}:${association.idCoating}`,
      association.surchargeEnabled,
    ]),
  );
  const privacyEnabledByBrand = new Map(
    brandPrivacies.map((association) => [
      `${association.idBrand}:${association.idPrivacy}`,
      association.surchargeEnabled,
    ]),
  );

  return pieces.map((piece) => ({
    ...piece,
    diagramMetadata: {
      dimensionMode:
        dimensionModeBySysConf.get(`${piece.idSyst}:${piece.idConf}`) ??
        DimensionMode.STANDARD,
      hasCoating:
        piece.idCoat != null &&
        coatingEnabledByBrand.get(`${piece.idBrand}:${piece.idCoat}`) === true,
      hasPrivacy:
        piece.idPrivacy != null &&
        privacyEnabledByBrand.get(`${piece.idBrand}:${piece.idPrivacy}`) ===
          true,
    },
  }));
}
