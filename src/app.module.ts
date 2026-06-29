import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
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
import { OrdersModule } from './orders/orders.module';
import { PricingRulesModule } from './pricing-rules/pricing-rules.module';
import { NotificationsModule } from './notifications/notifications.module';
import { GlobalParametersModule } from './global-parameters/global-parameters.module';
import { DimensionPoliciesModule } from './dimension-policies/dimension-policies.module';
import { GeoModule } from './geo/geo.module';
import { JwtAuthGuard } from './auth/guards/auth/auth.guard';
import { RolesGuard } from './auth/guards/roles/roles.guard';
import { ConfigModule } from '@nestjs/config';
import { SessionTouchGuard } from './auth/guards/auth/session-touch.guard';
import { BrandingsModule } from './brandings/brandings.module';
import { PaymentsModule } from './payments/payments.module';
import { LogsModule } from './logs/logs.module';
import { MuntinPatternsModule } from './muntin-patterns/muntin-patterns.module';
import { MuntinTypesModule } from './muntin-types/muntin-types.module';
import { ActiveOptionsModule } from './active-options/active-options.module';
import { PreparationOptionsModule } from './preparation-options/preparation-options.module';
import { SillOptionsModule } from './sill-options/sill-options.module';
import { ReinforcementOptionsModule } from './reinforcement-options/reinforcement-options.module';
import { ConfigCategoriesModule } from './config-categories/config-categories.module';
import { LinearPricingRulesModule } from "./linear-pricing-rules/linear-pricing-rules.module";
import { ScheduleModule } from '@nestjs/schedule';


@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // para que ConfigService funcione en todo el app
    }),
    ScheduleModule.forRoot(),

    PrismaModule,
    ProductsModule,
    SystemsModule,
    UsersModule,
    FrameColorModule,
    ConfigSModule,
    CoatingModule,
    CrystalsModule,
    TintsModule,
    AuthModule,
    EstimatesModule,
    PiecesModule,
    BrandsModule,
    RolesModule,
    OrdersModule,
    PricingRulesModule,
    NotificationsModule,
    GlobalParametersModule,
    DimensionPoliciesModule,
    GeoModule,
    BrandingsModule,
    PaymentsModule,
    LogsModule,
    MuntinPatternsModule,
    MuntinTypesModule,
    ActiveOptionsModule,
    PreparationOptionsModule,
    SillOptionsModule,
    ReinforcementOptionsModule,
    ConfigCategoriesModule,
    LinearPricingRulesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: SessionTouchGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule { }
