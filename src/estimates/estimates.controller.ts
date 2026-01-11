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
} from '@nestjs/common';
import { EstimatesService } from './estimates.service';
import { CreateEstimateDto } from './dto/create-estimate.dto';
import { UpdateEstimateDto } from './dto/update-estimate.dto';
import { JwtAuthGuard } from 'src/auth/guards/auth/auth.guard';
import { Request } from 'express';
import { CreatePieceDto } from 'src/pieces/dto/create-piece.dto';
import type { AuthUser } from 'src/auth/types/auth-user.type';

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
      width: number;
      height: number;
      heightLeft?: number;
      heightRight?: number;
      legHeight?: number;
    },
  ) {
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
  calculatePieceMetrics(@Body() pieceDto: CreatePieceDto, @Req() req: Request) {
    const user = req.user as AuthUser;
    return this.estimatesService.calculateAndReturnPieceMetrics(pieceDto, user.id);
  }

  @Post()
  create(@Body() dto: CreateEstimateDto, @Req() req: Request) {
    const user = req.user as AuthUser;
    return this.estimatesService.createEstimate(dto, user.id);
  }

  // ✅ admin/operator: todos
  // ✅ client/dealer: solo los suyos
  @Get()
  findAll(@Req() req: Request) {
    return this.estimatesService.findAllForUser(req.user as AuthUser);
  }


  // ✅ admin/operator: cualquiera
  // ✅ client/dealer: solo si es dueño
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.estimatesService.findOneForUser(id, req.user as AuthUser);
  }

  // 🔒 SOLO el que lo creó (aunque sea admin/operator)
  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEstimateDto,
    @Req() req: Request,
  ) {
    const user = req.user as AuthUser;

    // ✅ valida dueño fuerte
    await this.estimatesService.assertEstimateOwnerOrThrow(id, user);

    // y usa tu método original (que ya valida idUser y active)
    return this.estimatesService.updateEstimate(id, dto, user.id);
  }

  // 🔒 SOLO el que lo creó (aunque sea admin/operator)
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const user = req.user as AuthUser;

    // ✅ valida dueño fuerte
    await this.estimatesService.assertEstimateOwnerOrThrow(id, user);

    return this.estimatesService.deleteEstimate({ id });
  }
}
