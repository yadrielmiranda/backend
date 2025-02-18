import { Module } from '@nestjs/common';
import { TintsService } from './tints.service';
import { TintsController } from './tints.controller';

@Module({
  controllers: [TintsController],
  providers: [TintsService],
})
export class TintsModule {}
