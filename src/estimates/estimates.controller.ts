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

@UseGuards(JwtAuthGuard)
@Controller('estimates')
export class EstimatesController {
  constructor(private readonly estimatesService: EstimatesService) {}

  // Endpoint para que el frontend calcule una pieza
  @Post('calculate-piece')
  calculatePieceMetrics(
    @Body() pieceDto: CreatePieceDto,
    @Req() req: Request,
  ) {
    const user = req.user as { id: number };
    return this.estimatesService.calculateAndReturnPieceMetrics(pieceDto, user.id);
  }

  // Endpoint para crear un estimado completo
  @Post()
  create(
    @Body() createEstimateDto: CreateEstimateDto,
    @Req() req: Request,
  ) {
    const user = req.user as { id: number; username: string };
    return this.estimatesService.createEstimate(createEstimateDto, user.id);
  }

  // Endpoint para obtener todos los estimados del usuario
  @Get()
  findAll(@Req() req: Request) {
    const user = req.user as { id: number };
    return this.estimatesService.estimates({
      where: { idUser: user.id },
    });
  }

  // Endpoint para obtener un estimado específico
  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const user = req.user as { id: number };
    const estimate = await this.estimatesService.estimate({ id });

    if (!estimate || estimate.idUser !== user.id) {
      throw new NotFoundException(`Estimate with ID #${id} not found or access denied.`);
    }

    return estimate;
  }

  // Endpoint para actualizar un estimado
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateEstimateDto: UpdateEstimateDto,
    @Req() req: Request,
  ) {
    const user = req.user as { id: number };
    return this.estimatesService.updateEstimate(id, updateEstimateDto, user.id);
  }

  // Endpoint para eliminar un estimado
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const user = req.user as { id: number };
    
    const estimate = await this.estimatesService.estimate({ id });
    if (!estimate || estimate.idUser !== user.id) {
        throw new NotFoundException(`Estimate with ID #${id} not found or access denied.`);
    }

    return this.estimatesService.deleteEstimate({ id });
  }
}
