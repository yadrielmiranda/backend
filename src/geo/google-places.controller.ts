import { Body, Controller, Post } from '@nestjs/common';
import {
  PlaceDetailsDto,
  PlacesAutocompleteDto,
} from './dto/google-places.dto';
import { GooglePlacesService } from './google-places.service';

// The global JWT and role guards protect both endpoints.
@Controller('geo/places')
export class GooglePlacesController {
  constructor(private readonly places: GooglePlacesService) {}

  @Post('autocomplete')
  autocomplete(@Body() input: PlacesAutocompleteDto) {
    return this.places.autocomplete(input);
  }

  @Post('details')
  details(@Body() input: PlaceDetailsDto) {
    return this.places.details(input);
  }
}
