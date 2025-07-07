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

// ✅ Se aplica el guard a todas las rutas del controlador
@UseGuards(JwtAuthGuard)
@Controller('estimates')
export class EstimatesController {
  constructor(private readonly estimatesService: EstimatesService) {}

  @Post()
  create(
    @Body() createEstimateDto: CreateEstimateDto,
    @Req() req: Request,
  ) {
    // El tipo 'user' se infiere del payload del JWT que se adjunta a la request
    const user = req.user as { id: number; username: string };
    return this.estimatesService.createEstimate(createEstimateDto, user.id);
  }

  @Get()
  findAll(@Req() req: Request) {
    const user = req.user as { id: number };
    // ✅ Se asegura de que solo se devuelvan los presupuestos del usuario logueado.
    return this.estimatesService.estimates({
      where: { idUser: user.id },
    });
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const user = req.user as { id: number };
    const estimate = await this.estimatesService.estimate({ id });

    // ✅ CAPA DE SEGURIDAD ADICIONAL:
    // Aunque el servicio encuentra el presupuesto, aquí nos aseguramos de que pertenezca al usuario.
    if (estimate.idUser !== user.id) {
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
    
    // ✅ Se llama al método de servicio corregido, que maneja toda la lógica
    // de actualización (incluyendo piezas) y la verificación de permisos.
    return this.estimatesService.updateEstimate(id, updateEstimateDto, user.id);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const user = req.user as { id: number };
    
    // ✅ Se añade una capa de seguridad para verificar la propiedad antes de borrar.
    // El servicio también lo verifica, pero es una buena práctica ser explícito.
    const estimate = await this.estimatesService.estimate({ id });
    if (estimate.idUser !== user.id) {
        throw new NotFoundException(`Estimate with ID #${id} not found or access denied.`);
    }

    return this.estimatesService.deleteEstimate({ id });
  }
}
