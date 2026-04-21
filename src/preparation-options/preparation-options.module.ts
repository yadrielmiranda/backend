import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { PreparationOptionsController } from './preparation-options.controller';
import { PreparationOptionsService } from './preparation-options.service';

@Module({
  imports: [PrismaModule],
  controllers: [PreparationOptionsController],
  providers: [PreparationOptionsService],
  exports: [PreparationOptionsService],
})
export class PreparationOptionsModule {}