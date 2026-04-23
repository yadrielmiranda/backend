import { Module } from '@nestjs/common';
import { SystemsService } from './systems.service';
import { SystemsController } from './systems.controller';
import { PrismaModule } from '@/prisma/prisma.module';

@Module({
  imports:[PrismaModule],
  controllers: [SystemsController],
  providers: [SystemsService],
})
export class SystemsModule {}
