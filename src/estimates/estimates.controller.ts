// @/estimates/estimates.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
  UseGuards,
  Req,
  Res,
  BadRequestException,
  Query,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { EstimatesService, type PdfView } from './estimates.service';
import {
  CreateEstimateHeaderDto,
  UpdateEstimateHeaderDto,
} from './dto/estimate-header.dto';

import { CreatePieceDto } from '@/pieces/dto/create-piece.dto';
import { JwtAuthGuard } from '@/auth/guards/auth/auth.guard';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { EstimatePublicShareService } from './public-share/estimate-public-share.service';

@UseGuards(JwtAuthGuard)
@Controller('estimates')
export class EstimatesController {
  constructor(
    private readonly estimatesService: EstimatesService,
    private readonly estimatePublicShareService: EstimatePublicShareService,
  ) { }

  @Post('preview-dimension')
  async previewDimension(
    @Body()
    body: {
      idSyst: number;
      idConf: number;
      idCryst: number;
      idReinforcementOption?: number | null;

      width?: number;
      height: number;
      heightLeft?: number;
      heightRight?: number;
      legHeight?: number;

      doorWidth?: number;
      leftSideliteWidth?: number;
      rightSideliteWidth?: number;
      leftPanels?: number;
      rightPanels?: number;
      panelCount?: number;
      horizontalHeights?: number[];
    },
  ) {
    for (const [key, value] of Object.entries({
      idSyst: body.idSyst,
      idConf: body.idConf,
      idCryst: body.idCryst,
      height: body.height,
    })) {
      if (!Number.isFinite(value as number)) {
        throw new BadRequestException(`Invalid parameter: ${key}`);
      }
    }

    const optionalNumbers = {
      idReinforcementOption: body.idReinforcementOption,
      width: body.width,
      heightLeft: body.heightLeft,
      heightRight: body.heightRight,
      legHeight: body.legHeight,
      doorWidth: body.doorWidth,
      leftSideliteWidth: body.leftSideliteWidth,
      rightSideliteWidth: body.rightSideliteWidth,
      leftPanels: body.leftPanels,
      rightPanels: body.rightPanels,
      panelCount: body.panelCount,
    };

    for (const [key, value] of Object.entries(optionalNumbers)) {
      if (
        value !== undefined &&
        value !== null &&
        !Number.isFinite(value as number)
      ) {
        throw new BadRequestException(`Invalid parameter: ${key}`);
      }
    }

    if (
      body.horizontalHeights !== undefined &&
      !Array.isArray(body.horizontalHeights)
    ) {
      throw new BadRequestException(
        'Invalid parameter: horizontalHeights',
      );
    }

    return this.estimatesService.previewDimensionValidation(body);
  }

  @Post('calculate-piece')
  calculatePieceMetrics(
    @Body() pieceDto: CreatePieceDto,
    @Req() req: Request,
  ) {
    const user = req.user as AuthUser;

    return this.estimatesService.calculateAndReturnPieceMetrics(
      pieceDto,
      user.id,
    );
  }

  // =====================================================
  // FLUJO PERSISTENTE
  // =====================================================

  /**
   * Crea inmediatamente el encabezado del Estimate en DB,
   * todavía sin piezas y con todos los totales en cero.
   */
  @Post('initialize')
  initializeEstimate(
    @Body() dto: CreateEstimateHeaderDto,
    @Req() req: Request,
  ) {
    const user = req.user as AuthUser;

    return this.estimatesService.createEmptyEstimate(dto, user.id);
  }

  /**
   * Guarda solamente cambios del encabezado.
   * No modifica ni elimina piezas.
   */
  @Patch(':id/header')
  updateEstimateHeader(
    @Param('id', ParseIntPipe) estimateId: number,
    @Body() dto: UpdateEstimateHeaderDto,
    @Req() req: Request,
  ) {
    const user = req.user as AuthUser;

    return this.estimatesService.updateEstimateHeader(
      estimateId,
      dto,
      user.id,
    );
  }

  /**
   * Calcula y guarda una pieza nueva dentro del Estimate.
   * Después actualiza los totales del Estimate.
   */
  @Post(':id/pieces')
  addPiece(
    @Param('id', ParseIntPipe) estimateId: number,
    @Body() dto: CreatePieceDto,
    @Req() req: Request,
  ) {
    const user = req.user as AuthUser;

    return this.estimatesService.addPieceToEstimate(
      estimateId,
      dto,
      user.id,
    );
  }

  /**
 * Aplica un mismo Dealer Markup a todas las piezas.
 * Toda la operación se ejecuta en una sola transacción.
 */
  @Patch(':id/pieces/general-markup')
  applyGeneralDealerMarkup(
    @Param('id', ParseIntPipe) estimateId: number,
    @Body()
    body: {
      dealerMarkup: number;
    },
    @Req() req: Request,
  ) {
    const user = req.user as AuthUser;
    const dealerMarkup = Number(body.dealerMarkup);

    if (!Number.isFinite(dealerMarkup) || dealerMarkup < 0) {
      throw new BadRequestException(
        'dealerMarkup must be a number greater than or equal to zero.',
      );
    }

    return this.estimatesService.applyGeneralDealerMarkupToEstimate(
      estimateId,
      dealerMarkup,
      user.id,
    );
  }

  /**
 * Aplica Frame Color, Tint o Coating
 * a todas las piezas del Estimate.
 */
  @Patch(':id/pieces/bulk-attribute')
  applyBulkPieceAttribute(
    @Param('id', ParseIntPipe) estimateId: number,
    @Body()
    body: {
      idFC?: number;
      idTint?: number;
      idCoat?: number;
    },
    @Req() req: Request,
  ) {
    const user = req.user as AuthUser;

    const changes = {
      ...(body.idFC !== undefined
        ? { idFC: Number(body.idFC) }
        : {}),

      ...(body.idTint !== undefined
        ? { idTint: Number(body.idTint) }
        : {}),

      ...(body.idCoat !== undefined
        ? { idCoat: Number(body.idCoat) }
        : {}),
    };

    const providedValues = Object.values(changes);

    if (providedValues.length !== 1) {
      throw new BadRequestException(
        'Provide exactly one of idFC, idTint or idCoat.',
      );
    }

    if (
      !Number.isInteger(providedValues[0]) ||
      providedValues[0] <= 0
    ) {
      throw new BadRequestException(
        'The selected value must be a positive integer.',
      );
    }

    return this.estimatesService
      .applyBulkPieceAttributeToEstimate(
        estimateId,
        changes,
        user.id,
      );
  }

  /**
   * Recalcula y actualiza una pieza existente.
   * Después actualiza los totales del Estimate.
   */
  @Patch(':id/pieces/:pieceId')
  updatePiece(
    @Param('id', ParseIntPipe) estimateId: number,
    @Param('pieceId', ParseIntPipe) pieceId: number,
    @Body() dto: CreatePieceDto,
    @Req() req: Request,
  ) {
    const user = req.user as AuthUser;

    return this.estimatesService.updatePieceInEstimate(
      estimateId,
      pieceId,
      dto,
      user.id,
    );
  }

  /**
   * Elimina una pieza y actualiza inmediatamente
   * los totales del Estimate.
   */
  @Delete(':id/pieces/:pieceId')
  deletePiece(
    @Param('id', ParseIntPipe) estimateId: number,
    @Param('pieceId', ParseIntPipe) pieceId: number,
    @Req() req: Request,
  ) {
    const user = req.user as AuthUser;

    return this.estimatesService.deletePieceFromEstimate(
      estimateId,
      pieceId,
      user.id,
    );
  }



  @Get()
  findAll(@Req() req: Request) {
    return this.estimatesService.findAllForUser(
      req.user as AuthUser,
    );
  }

  @Post(':id/public-token')
  getOrCreatePublicToken(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    const user = req.user as AuthUser;

    return this.estimatePublicShareService.getOrCreatePublicLinkToken(
      id,
      user,
    );
  }

  @Get(':id/pdf')
  async pdf(
    @Param('id', ParseIntPipe) id: number,
    @Query('view') viewParam: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = req.user as AuthUser;

    const roleName =
      (user as any)?.role?.name ??
      (user as any)?.roleName ??
      null;

    // comentario en español: si no mandan view,
    // elegimos un valor predeterminado según el rol.
    const defaultView: PdfView =
      roleName === 'dealer'
        ? 'dealer_internal'
        : roleName === 'admin' || roleName === 'operator'
          ? 'admin'
          : 'client';

    const normalized = (viewParam ?? '').trim().toLowerCase();

    const view: PdfView =
      normalized === 'client'
        ? 'client'
        : normalized === 'dealer_internal'
          ? 'dealer_internal'
          : normalized === 'dealer_public'
            ? 'dealer_public'
            : normalized === 'admin'
              ? 'admin'
              : normalized === ''
                ? defaultView
                : (() => {
                  throw new BadRequestException(
                    'view inválido. Use: client | dealer_internal | dealer_public | admin',
                  );
                })();

    const pdfBuffer =
      await this.estimatesService.generateEstimatePdfBufferForUser(
        id,
        user,
        view,
      );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="estimate-${id}.pdf"`,
    );

    return res.end(pdfBuffer);
  }

  @Post(':id/recalculate')
  async recalculate(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    const user = req.user as AuthUser;

    return this.estimatesService.recalculateExpiredEstimate(
      id,
      user,
    );
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    return this.estimatesService.findOneForUser(
      id,
      req.user as AuthUser,
    );
  }

  @Delete(':id')
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    const user = req.user as AuthUser;

    await this.estimatesService.assertEstimateOwnerOrThrow(
      id,
      user,
    );

    return this.estimatesService.deleteEstimate(
      { id },
      user.id,
    );
  }
}