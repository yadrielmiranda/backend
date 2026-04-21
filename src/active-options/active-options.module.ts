import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ActiveOptionsController } from './active-options.controller';
import { ActiveOptionsService } from './active-options.service';

@Module({
  imports: [PrismaModule],
  controllers: [ActiveOptionsController],
  providers: [ActiveOptionsService],
  exports: [ActiveOptionsService],
})
export class ActiveOptionsModule {}