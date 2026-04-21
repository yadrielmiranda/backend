import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { SillOptionsController } from './sill-options.controller';
import { SillOptionsService } from './sill-options.service';

@Module({
  imports: [PrismaModule],
  controllers: [SillOptionsController],
  providers: [SillOptionsService],
  exports: [SillOptionsService],
})
export class SillOptionsModule {}