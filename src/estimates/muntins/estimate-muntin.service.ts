import { Injectable, BadRequestException } from '@nestjs/common';

import { CreatePieceDto } from '@/pieces/dto/create-piece.dto';
import { UpsertPieceDto } from '../dto/update-estimate.dto';
import type { PrismaTransactionClient } from '../dimensions/estimate-dimension-validation.service';

@Injectable()
export class EstimateMuntinService {
  buildPieceMuntinCreateInput(
    muntin?: CreatePieceDto['muntin'] | UpsertPieceDto['muntin'] | null,
  ) {
    if (!muntin) return undefined;

    const panels = Array.isArray(muntin.panels) ? muntin.panels : [];

    const totalLites = panels.reduce((sum, panel) => {
      const h = Number(panel.horizontalLites || 0);
      const v = Number(panel.verticalLites || 0);
      return sum + h * v;
    }, 0);

    return {
      pattern: { connect: { id: muntin.idPattern } },
      ...(muntin.idType ? { type: { connect: { id: muntin.idType } } } : {}),
      totalLites,
      ...(panels.length > 0
        ? {
            panels: {
              create: panels.map((panel) => ({
                panelIndex: panel.panelIndex,
                panelCode: panel.panelCode ?? null,
                panelLabel: panel.panelLabel,
                horizontalLites: panel.horizontalLites,
                verticalLites: panel.verticalLites,
              })),
            },
          }
        : {}),
    };
  }

  parseConfigMuntinLayout(layout: unknown): Array<{
    panelIndex: number;
    panelCode?: string | null;
    panelLabel: string;
  }> {
    if (!Array.isArray(layout)) return [];

    return layout
      .map((item: any) => ({
        panelIndex: Number(item?.panelIndex),
        panelCode:
          item?.panelCode == null || String(item.panelCode).trim() === ''
            ? null
            : String(item.panelCode).trim(),
        panelLabel: String(item?.panelLabel ?? '').trim(),
      }))
      .filter(
        (item) =>
          Number.isInteger(item.panelIndex) &&
          item.panelIndex >= 1 &&
          item.panelLabel.length > 0,
      )
      .sort((a, b) => a.panelIndex - b.panelIndex);
  }

  buildDefaultPanelsFromConfigLayout(
    configLayout: Array<{
      panelIndex: number;
      panelCode?: string | null;
      panelLabel: string;
    }>,
    incomingPanels?: Array<{
      panelIndex?: number;
      panelCode?: string;
      panelLabel?: string;
      horizontalLites?: number;
      verticalLites?: number;
    }>,
  ) {
    const incomingByIndex = new Map<number, (typeof incomingPanels)[number]>();

    for (const panel of incomingPanels ?? []) {
      const idx = Number(panel?.panelIndex);
      if (Number.isInteger(idx) && idx >= 1) {
        incomingByIndex.set(idx, panel);
      }
    }

    return configLayout.map((panel) => {
      const incoming = incomingByIndex.get(panel.panelIndex);

      return {
        panelIndex: panel.panelIndex,
        panelCode: panel.panelCode ?? null,
        panelLabel: panel.panelLabel,
        horizontalLites: Math.max(1, Number(incoming?.horizontalLites ?? 1)),
        verticalLites: Math.max(1, Number(incoming?.verticalLites ?? 1)),
      };
    });
  }

  async normalizePieceMuntinFromCatalog(
    muntin: CreatePieceDto['muntin'] | UpsertPieceDto['muntin'] | null | undefined,
    configLayoutRaw: unknown,
    tx: PrismaTransactionClient,
  ) {
    if (!muntin) return null;

    const pattern = await tx.muntinPattern.findUnique({
      where: { id: muntin.idPattern },
      select: {
        id: true,
        requiresLites: true,
      },
    });

    if (!pattern) {
      throw new BadRequestException(`Muntin pattern #${muntin.idPattern} not found.`);
    }

    if (muntin.idType) {
      const type = await tx.muntinType.findUnique({
        where: { id: muntin.idType },
        select: { id: true },
      });

      if (!type) {
        throw new BadRequestException(`Muntin type #${muntin.idType} not found.`);
      }
    }

    const configLayout = this.parseConfigMuntinLayout(configLayoutRaw);

    // comentario en espanol: Full View o cualquier pattern sin lites
    if (!pattern.requiresLites) {
      return {
        idPattern: muntin.idPattern,
        idType: muntin.idType ?? null,
        panels: [],
      };
    }

    if (configLayout.length === 0) {
      throw new BadRequestException(
        'This configuration does not define a muntin layout.',
      );
    }

    return {
      idPattern: muntin.idPattern,
      idType: muntin.idType ?? null,
      panels: this.buildDefaultPanelsFromConfigLayout(
        configLayout,
        Array.isArray(muntin.panels) ? muntin.panels : [],
      ),
    };
  }
}