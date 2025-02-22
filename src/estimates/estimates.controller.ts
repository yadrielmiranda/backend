import { Controller, Get, Post, Body, Patch, Param, Delete, Query } from '@nestjs/common';
import { EstimatesService } from './estimates.service';
import { CreateEstimateDto } from './dto/create-estimate.dto';
import { UpdateEstimateDto } from './dto/update-estimate.dto';
import { Estimate as EstimateModel } from '@prisma/client';

@Controller('estimates')
export class EstimatesController {
  constructor(private readonly estimatesService: EstimatesService) { }

  @Post()
  async createEstimate(
    @Body() estimateData: CreateEstimateDto,
  ): Promise<EstimateModel> {
    const { code, name, units, total, idUser, active } = estimateData;
    return this.estimatesService.createEstimate({  //Aqui es donde se verifica que exista ese id en la tabla product
      code,
      name,
      units,
      total,
      user: {
        connect: { id: idUser },
      },
      active
    });
  }

  @Get()
  async getAllEstimates(): Promise<EstimateModel[]> {
    return this.estimatesService.estimates({});
  }

  @Get('mine') //en esta ruta busco los estimados que tienen el id de usuario que les paso en la query ejem: ?product=1
  async getEstimatesByUser(@Query('user') idU?: any): Promise<EstimateModel[]> {
    return this.estimatesService.estimates({ where: { idUser: Number(idU) } });
  }

  @Get(':id')
  async getEstimate(@Param('id') id: string): Promise<EstimateModel> {
    return this.estimatesService.estimate({ id: Number(id) });
  }

  @Patch(':id')
  async updateEstimate(
    @Param('id') id: string,
    @Body() estimateData: UpdateEstimateDto,
  ): Promise<EstimateModel> {
    return this.estimatesService.updateEstimate({
      where: { id: Number(id) },
      data: estimateData,
    });
  }

  @Delete(':id')
  async deleteEstimate(@Param('id') id: string): Promise<EstimateModel> {
    return this.estimatesService.deleteEstimate({ id: Number(id) });
  }


}
