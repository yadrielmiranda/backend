import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { GarageDesignsController } from './garage-designs.controller';
import { GarageDesignsService } from './garage-designs.service';

@Module({ imports: [PrismaModule], controllers: [GarageDesignsController], providers: [GarageDesignsService] })
export class GarageDesignsModule {}
