import { Module } from '@nestjs/common';
import { PiecesService } from './pieces.service';
import { PrismaModule } from '@/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [],
  providers: [PiecesService],
})
export class PiecesModule {}
