import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { MuntinPatternsController } from './muntin-patterns.controller';
import { MuntinPatternsService } from './muntin-patterns.service';

@Module({
  imports: [PrismaModule],
  controllers: [MuntinPatternsController],
  providers: [MuntinPatternsService],
})
export class MuntinPatternsModule {}