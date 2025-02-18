import { Module } from '@nestjs/common';
import { ConfigSService } from './config-s.service';
import { ConfigSController } from './config-s.controller';

@Module({
  controllers: [ConfigSController],
  providers: [ConfigSService],
})
export class ConfigSModule {}
