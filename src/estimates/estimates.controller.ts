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
  NotFoundException,
  Res,
  BadRequestException,
  Query,
} from '@nestjs/common';
import { EstimatesService, type PdfView } from './estimates.service';
import { CreateEstimateDto } from './dto/create-estimate.dto';
import { UpdateEstimateDto } from './dto/update-estimate.dto';
import { JwtAuthGuard } from '@/auth/guards/auth/auth.guard';
import { Request, Response } from 'express';
import { CreatePieceDto } from '@/pieces/dto/create-piece.dto';
import type { AuthUser } from '@/auth/types/auth-user.type';

@UseGuards(JwtAuthGuard)
@Controller('estimates')
export class EstimatesController {
  constructor(private readonly estimatesService: EstimatesService) { }

  @Post('preview-dimension')
  async previewDimension(
    @Body()
    body: {
      idSyst: number;
      idConf: number;
      idCryst: number;

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
    for (const [k, v] of Object.entries({
      idSyst: body.idSyst,
      idConf: body.idConf,
      idCryst: body.idCryst,
      height: body.height,
    })) {
      if (!Number.isFinite(v as number)) {
        throw new BadRequestException(`Invalid parameter: ${k}`);
      }
    }

    const optionalNumbers = {
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

    for (const [k, v] of Object.entries(optionalNumbers)) {
      if (v !== undefined && v !== null && !Number.isFinite(v as number)) {
        throw new BadRequestException(`Invalid parameter: ${k}`);
      }
    }

    if (
      body.horizontalHeights !== undefined &&
      !Array.isArray(body.horizontalHeights)
    ) {
      throw new BadRequestException('Invalid parameter: horizontalHeights');
    }

    return this.estimatesService.previewDimensionValidation(body);
  }

  @Post('calculate-piece')
  calculatePieceMetrics(@Body() pieceDto: CreatePieceDto, @Req() req: Request) {
    const user = req.user as AuthUser;
    return this.estimatesService.calculateAndReturnPieceMetrics(pieceDto, user.id);
  }

  @Post()
  create(@Body() dto: CreateEstimateDto, @Req() req: Request) {
    const user = req.user as AuthUser;
    return this.estimatesService.createEstimate(dto, user.id);
  }

  @Get()
  findAll(@Req() req: Request) {
    return this.estimatesService.findAllForUser(req.user as AuthUser);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.estimatesService.findOneForUser(id, req.user as AuthUser);
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
      (user as any)?.role?.name ?? (user as any)?.roleName ?? null;

    // comentario en espanol: si no mandan view, elegimos un default por rol
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
                    `view inválido. Use: client | dealer_internal | dealer_public | admin`,
                  );
                })();

    const pdfBuffer = await this.estimatesService.generateEstimatePdfBufferForUser(
      id,
      user,
      view,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="estimate-${id}.pdf"`);

    return res.end(pdfBuffer);
  }

  @Post(':id/recalculate')
  async recalculate(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    const user = req.user as AuthUser;

    return this.estimatesService.recalculateExpiredEstimate(id, user);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEstimateDto,
    @Req() req: Request,
  ) {
    const user = req.user as AuthUser;

    // ✅ valida dueño fuerte
    await this.estimatesService.assertEstimateOwnerOrThrow(id, user);

    return this.estimatesService.updateEstimate(id, dto, user.id);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const user = req.user as AuthUser;

    // ✅ valida dueño fuerte
    await this.estimatesService.assertEstimateOwnerOrThrow(id, user);

    return this.estimatesService.deleteEstimate({ id }, user.id);
  }
}
