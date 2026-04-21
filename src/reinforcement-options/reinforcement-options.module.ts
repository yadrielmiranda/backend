import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ReinforcementOptionsController } from './reinforcement-options.controller';
import { ReinforcementOptionsService } from './reinforcement-options.service';

@Module({
  imports: [PrismaModule],
  controllers: [ReinforcementOptionsController],
  providers: [ReinforcementOptionsService],
  exports: [ReinforcementOptionsService],
})
export class ReinforcementOptionsModule {}