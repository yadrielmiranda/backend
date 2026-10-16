import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';

class PlacesSessionDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,36}$/, {
    message: 'sessionToken must be a URL-safe token of at most 36 characters',
  })
  sessionToken: string;
}

export class PlacesAutocompleteDto extends PlacesSessionDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(3, 200)
  input: string;
}

export class PlaceDetailsDto extends PlacesSessionDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,512}$/, {
    message: 'placeId must be a valid Google Place ID',
  })
  placeId: string;
}
