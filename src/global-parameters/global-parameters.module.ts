import { Module } from '@nestjs/common';
import { GlobalParametersService } from './global-parameters.service';
import { GlobalParametersController } from './global-parameters.controller';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [GlobalParametersController],
  providers: [GlobalParametersService],
})
export class GlobalParametersModule {}
