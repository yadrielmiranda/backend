import { Module } from '@nestjs/common';
import { CoatingService } from './coating.service';
import { CoatingController } from './coating.controller';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [CoatingController],
  providers: [CoatingService],
})
export class CoatingModule { }
