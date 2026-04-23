import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { MuntinTypesController } from './muntin-types.controller';
import { MuntinTypesService } from './muntin-types.service';

@Module({
  imports: [PrismaModule],
  controllers: [MuntinTypesController],
  providers: [MuntinTypesService],
})
export class MuntinTypesModule {}