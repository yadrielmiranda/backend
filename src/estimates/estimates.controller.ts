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
  Query
} from '@nestjs/common';
import { EstimatesService } from './estimates.service';
import { CreateEstimateDto } from './dto/create-estimate.dto';
import { UpdateEstimateDto } from './dto/update-estimate.dto';
import { JwtAuthGuard } from 'src/auth/guards/auth/auth.guard';
import { Request } from 'express';
import { CreatePieceDto } from 'src/pieces/dto/create-piece.dto';
import { Prisma } from '@prisma/client';

// Un tipo para el payload del usuario que viene en el token
interface UserPayload {
  id: number;
  role: { name: string; };
}

@UseGuards(JwtAuthGuard)
@Controller('estimates')
export class EstimatesController {
  constructor(private readonly estimatesService: EstimatesService) {}
  // Valida dimensiones sin guardar (pre-chequeo para la UI)
@Post('preview-dimension')
async previewDimension(
  @Body()
  body: {
    idSyst: number;
    idConf: number;
    idCryst: number;
    width: number;
    height: number;
    heightLeft?: number;
    heightRight?: number;
    legHeight?: number;
  },
) {
  // (opcional) validación mínima muy básica
  for (const [k, v] of Object.entries({
    idSyst: body.idSyst,
    idConf: body.idConf,
    idCryst: body.idCryst,
    width: body.width,
    height: body.height,
  })) {
    if (!Number.isFinite(v as number)) {
      throw new NotFoundException(`Parámetro inválido: ${k}`);
    }
  }

  return this.estimatesService.previewDimensionValidation(body);
}


  @Post('calculate-piece')
  calculatePieceMetrics(
    @Body() pieceDto: CreatePieceDto,
    @Req() req: Request,
  ) {
    const user = req.user as { id: number };
    return this.estimatesService.calculateAndReturnPieceMetrics(pieceDto, user.id);
  }

  @Post()
  create(
    @Body() createEstimateDto: CreateEstimateDto,
    @Req() req: Request,
  ) {
    const user = req.user as { id: number; username: string };
    return this.estimatesService.createEstimate(createEstimateDto, user.id);
  }

  // --- FUNCIÓN MODIFICADA ---
  @Get()
  findAll(@Req() req: Request) {
    const user = req.user as UserPayload;
    
    // Preparamos el filtro
    const whereClause: Prisma.EstimateWhereInput = {};

    // Si el usuario NO es un admin, filtramos por su ID.
    // Si ES un admin, el filtro se queda vacío, devolviendo todo.
    if (user.role.name !== 'admin') {
      whereClause.idUser = user.id;
    }

    return this.estimatesService.estimates({
      where: whereClause,
    });
  }
/*
  // Valida dimensiones sin guardar (pre-chequeo para la UI)
@Get('validate-piece')
async validatePiece(
  @Query('idSyst') idSyst: string,
  @Query('idConf') idConf: string,
  @Query('idCryst') idCryst: string,
  @Query('widthIn') widthIn: string,
  @Query('heightIn') heightIn: string,
  @Query('heightLeftIn') heightLeftIn?: string,
  @Query('heightRightIn') heightRightIn?: string,
  @Query('legHeightIn') legHeightIn?: string,
) {
  // convierte a número de forma segura
  const payload = {
    idSyst: Number(idSyst),
    idConf: Number(idConf),
    idCryst: Number(idCryst),
    width: Number(widthIn),
    height: Number(heightIn),
    heightLeft: heightLeftIn != null ? Number(heightLeftIn) : undefined,
    heightRight: heightRightIn != null ? Number(heightRightIn) : undefined,
    legHeight: legHeightIn != null ? Number(legHeightIn) : undefined,
  };

  // (opcional) validación mínima
  for (const [k, v] of Object.entries({
    idSyst: payload.idSyst,
    idConf: payload.idConf,
    idCryst: payload.idCryst,
    width: payload.width,
    height: payload.height,
  })) {
    if (!Number.isFinite(v as number)) {
      throw new NotFoundException(`Parámetro inválido: ${k}`);
    }
  }

  return this.estimatesService.previewDimensionValidation(payload);
} */


  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const user = req.user as { id: number, role: { name: string } };
    const estimate = await this.estimatesService.estimate({ id });

    if (!estimate) {
        throw new NotFoundException(`Estimate with ID #${id} not found.`);
    }

    // Un admin puede ver cualquier estimado, un usuario normal solo los suyos.
    if (user.role.name !== 'admin' && estimate.idUser !== user.id) {
        throw new NotFoundException(`Estimate with ID #${id} not found or access denied.`);
    }

    return estimate;
  }

  

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateEstimateDto: UpdateEstimateDto,
    @Req() req: Request,
  ) {
    const user = req.user as { id: number };
    return this.estimatesService.updateEstimate(id, updateEstimateDto, user.id);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const user = req.user as { id: number };
    
    const estimate = await this.estimatesService.estimate({ id });
    // Solo el dueño puede borrar
    if (!estimate || estimate.idUser !== user.id) {
        throw new NotFoundException(`Estimate with ID #${id} not found or access denied.`);
    }

    return this.estimatesService.deleteEstimate({ id });
  }
}