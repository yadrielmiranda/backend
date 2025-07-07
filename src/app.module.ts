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
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { EstimatesModule } from './estimates/estimates.module';
import { PiecesModule } from './pieces/pieces.module';
import { BrandsModule } from './brands/brands.module';
import { ConfigSModule } from './config-s/config-s.module';
import { RolesModule } from './roles/roles.module';


@Module({
  imports: [PrismaModule ,ProductsModule, SystemsModule, UsersModule, FrameColorModule, ConfigSModule, CoatingModule, CrystalsModule, TintsModule, AuthModule, EstimatesModule, PiecesModule, BrandsModule, RolesModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
