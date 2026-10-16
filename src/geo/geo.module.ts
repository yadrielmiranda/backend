// @/geo/geo.module.ts
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';
import { GooglePlacesController } from './google-places.controller';
import { GooglePlacesService } from './google-places.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 5000,
      maxRedirects: 3,
    }),
  ],
  controllers: [GeoController, GooglePlacesController],
  providers: [GeoService, GooglePlacesService],
})
export class GeoModule {}
