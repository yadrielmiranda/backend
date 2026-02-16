import { Module } from '@nestjs/common';
import { BrandingsService } from './brandings.service';
import { BrandingsController } from './brandings.controller';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [BrandingsController],
  providers: [BrandingsService],
})
export class BrandingsModule {}
