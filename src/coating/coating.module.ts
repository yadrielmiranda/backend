import { Module } from '@nestjs/common';
import { CoatingService } from './coating.service';
import { CoatingController } from './coating.controller';

@Module({
  controllers: [CoatingController],
  providers: [CoatingService],
})
export class CoatingModule {}
