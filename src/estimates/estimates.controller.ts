import { Controller, Get, Post, Body, Patch, Param, Delete, ParseIntPipe } from '@nestjs/common';
import { EstimatesService } from './estimates.service';
import { CreateEstimateDto } from './dto/create-estimate.dto';
import { UpdateEstimateDto } from './dto/update-estimate.dto';
import { CreatePieceDto } from 'src/pieces/dto/create-piece.dto'; // Asegúrate que la ruta sea correcta
import { UpdatePieceDto } from 'src/pieces/dto/update-piece.dto'; // Necesitarás crear este DTO
import { Estimate as EstimateModel } from '@prisma/client';

@Controller('estimates')
export class EstimatesController {
  constructor(private readonly estimatesService: EstimatesService) { }

  // --- Endpoints para Presupuestos (Estimates) ---

  @Post()
  async createEstimate(@Body() createEstimateDto: CreateEstimateDto): Promise<EstimateModel> {
    return this.estimatesService.createEstimate(createEstimateDto);
  }

  @Get()
  async getAllEstimates(): Promise<EstimateModel[]> {
    return this.estimatesService.estimates({});
  }

  @Get(':id')
  async getEstimate(@Param('id', ParseIntPipe) id: number): Promise<EstimateModel> {
    return this.estimatesService.estimate({ id });
  }

  @Patch(':id')
  async updateEstimate(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateEstimateDto: UpdateEstimateDto,
  ): Promise<EstimateModel> {
    return this.estimatesService.updateEstimate({
      where: { id },
      data: updateEstimateDto,
    });
  }

  @Delete(':id')
  async deleteEstimate(@Param('id', ParseIntPipe) id: number): Promise<EstimateModel> {
    return this.estimatesService.deleteEstimate({ id });
  }

  // --- Endpoints para Piezas (Pieces) anidadas dentro de un Presupuesto ---

  /**
   * Añade una nueva pieza a un presupuesto existente.
   * La lógica de recálculo de totales está en el servicio.
   */
  @Post(':id/pieces')
  async addPieceToEstimate(
    @Param('id', ParseIntPipe) estimateId: number,
    @Body() createPieceDto: CreatePieceDto,
  ): Promise<EstimateModel> {
    // Nota: Necesitarás crear el método 'addPieceToEstimate' en tu servicio.
    // return this.estimatesService.addPieceToEstimate(estimateId, createPieceDto);
    // Por ahora, devolvemos un placeholder.
    console.log(`Adding piece to estimate ${estimateId}`, createPieceDto);
    return this.estimatesService.estimate({ id: estimateId }); // Placeholder
  }

  /**
   * Actualiza una pieza específica dentro de un presupuesto.
   * La lógica de recálculo de totales está en el servicio.
   */
  @Patch(':id/pieces/:pieceId')
  async updatePieceInEstimate(
    @Param('id', ParseIntPipe) estimateId: number,
    @Param('pieceId', ParseIntPipe) pieceId: number,
    @Body() updatePieceDto: UpdatePieceDto,
  ): Promise<EstimateModel> {
    // Nota: Necesitarás crear el método 'updatePieceInEstimate' en tu servicio.
    // return this.estimatesService.updatePieceInEstimate(estimateId, pieceId, updatePieceDto);
    // Por ahora, devolvemos un placeholder.
     console.log(`Updating piece ${pieceId} in estimate ${estimateId}`, updatePieceDto);
    return this.estimatesService.estimate({ id: estimateId }); // Placeholder
  }

  /**
   * Elimina una pieza específica de un presupuesto.
   * La lógica de recálculo de totales está en el servicio.
   */
  @Delete(':id/pieces/:pieceId')
  async removePieceFromEstimate(
    @Param('id', ParseIntPipe) estimateId: number,
    @Param('pieceId', ParseIntPipe) pieceId: number,
  ): Promise<EstimateModel> {
    // Nota: Necesitarás crear el método 'removePieceFromEstimate' en tu servicio.
    // return this.estimatesService.removePieceFromEstimate(estimateId, pieceId);
    // Por ahora, devolvemos un placeholder.
     console.log(`Removing piece ${pieceId} from estimate ${estimateId}`);
    return this.estimatesService.estimate({ id: estimateId }); // Placeholder
  }
}