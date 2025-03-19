import { Module } from '@nestjs/common';
import { BrandsService } from './brands.service';
import { BrandsController } from './brands.controller';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [BrandsController],
  providers: [BrandsService],
})
export class BrandsModule {}
