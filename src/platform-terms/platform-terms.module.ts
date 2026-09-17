import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { PlatformTermsController } from './platform-terms.controller';
import { PlatformTermsService } from './platform-terms.service';

@Module({
  imports: [PrismaModule],
  controllers: [PlatformTermsController],
  providers: [PlatformTermsService],
  exports: [PlatformTermsService],
})
export class PlatformTermsModule {}
