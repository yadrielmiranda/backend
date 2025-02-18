import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ProductsModule } from './products/products.module';
import { SystemsModule } from './systems/systems.module';
import { UsersModule } from './users/users.module';
import { FrameColorModule } from './frame-color/frame-color.module';




import { CoatingModule } from './coating/coating.module';
import { CrystalsModule } from './crystals/crystals.module';
import { TintsModule } from './tints/tints.module';
import { ConfigSModule } from './config-s/config-s.module';
import { SystemConfigModule } from './system-config/system-config.module';
import { PrismaModule } from './prisma/prisma.module';


@Module({
  imports: [PrismaModule ,ProductsModule, SystemsModule, UsersModule, FrameColorModule, CoatingModule, CrystalsModule, TintsModule, ConfigSModule, SystemConfigModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
