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