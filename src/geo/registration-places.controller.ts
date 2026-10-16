import { Body, Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '@/auth/public.decorator';
import {
  PlaceDetailsDto,
  PlacesAutocompleteDto,
} from './dto/google-places.dto';
import { RegistrationPlacesService } from './registration-places.service';

@Controller('geo/registration/places')
export class RegistrationPlacesController {
  constructor(private readonly places: RegistrationPlacesService) {}

  @Public()
  @Post('autocomplete')
  autocomplete(@Req() request: Request, @Body() input: PlacesAutocompleteDto) {
    // Express applies the application's existing proxy policy; never trust raw XFF.
    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    return this.places.autocomplete(ip, input);
  }

  @Public()
  @Post('details')
  details(@Req() request: Request, @Body() input: PlaceDetailsDto) {
    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    return this.places.details(ip, input);
  }
}
