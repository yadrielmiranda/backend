import { Transform } from 'class-transformer';
import { IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

import {
  normalizePieceMark,
  PIECE_MARK_MAX_LENGTH,
} from '@/pieces/piece.constants';

export class UpdatePieceMarkDto {
  @ApiProperty({ maxLength: PIECE_MARK_MAX_LENGTH })
  @Transform(({ value }) => normalizePieceMark(value))
  @IsString()
  @MaxLength(PIECE_MARK_MAX_LENGTH)
  mark: string;
}
