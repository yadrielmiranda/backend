import { Module } from '@nestjs/common';
import { SystemConfigService } from './system-config.service';
import { SystemConfigController } from './system-config.controller';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [SystemConfigController],
  providers: [SystemConfigService],
})
export class SystemConfigModule { }
