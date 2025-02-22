import { Injectable } from '@nestjs/common';
import { UpdateEstimateDto } from './dto/update-estimate.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { Estimate, Prisma } from '@prisma/client';

@Injectable()
export class EstimatesService {

  constructor(private prisma: PrismaService) { }

  async estimate(
    estimateWhereUniqueInput: Prisma.EstimateWhereUniqueInput
  ): Promise<Estimate | null> {
    return this.prisma.estimate.findUnique({
      where: estimateWhereUniqueInput,
    });
  }

  async estimates(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.EstimateWhereUniqueInput;
    where?: Prisma.EstimateWhereInput;
    orderBy?: Prisma.EstimateOrderByWithRelationInput;
  }): Promise<Estimate[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.estimate.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
    });
  }

  async createEstimate(data: Prisma.EstimateCreateInput): Promise<Estimate> {
    return this.prisma.estimate.create({
      data,
    });
  }

  async updateEstimate(params: {
    where: Prisma.EstimateWhereUniqueInput;
    data: UpdateEstimateDto;
  }): Promise<Estimate> {
    const { where, data } = params;
    return this.prisma.estimate.update({
      data,
      where
    });
  }

  async deleteEstimate(where: Prisma.EstimateWhereUniqueInput): Promise<Estimate> {
    return this.prisma.estimate.delete({
      where
    });
  }
}
