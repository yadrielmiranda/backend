import { Module } from '@nestjs/common';
import { ConfigSService } from './config-s.service';
import { ConfigSController } from './config-s.controller';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ConfigSController],
  providers: [ConfigSService],
})
export class ConfigSModule {}
