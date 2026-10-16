// @/geo/geo.module.ts
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';
import { GooglePlacesController } from './google-places.controller';
import { GooglePlacesService } from './google-places.service';
import { RegistrationPlacesController } from './registration-places.controller';
import { RegistrationPlacesService } from './registration-places.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 5000,
      maxRedirects: 3,
    }),
  ],
  controllers: [
    GeoController,
    GooglePlacesController,
    RegistrationPlacesController,
  ],
  providers: [GeoService, GooglePlacesService, RegistrationPlacesService],
})
export class GeoModule {}
