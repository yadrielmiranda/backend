import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { DoorDesignsController } from './door-designs.controller';
import { DoorDesignsService } from './door-designs.service';

@Module({ imports: [PrismaModule], controllers: [DoorDesignsController], providers: [DoorDesignsService] })
export class DoorDesignsModule {}
