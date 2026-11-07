import { Body, Controller, Get, Param, ParseIntPipe, Patch } from '@nestjs/common';
import { IsOptional, IsString, Length, Matches, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import { Roles } from '@/auth/roles.decorator';
import { DoorDesignsService } from './door-designs.service';
import { DOOR_PRICE } from './door-design-policy';

class UpdateDoorDesignDto {
  @ValidateIf((_obj, value) => value !== undefined)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 80)
  code?: string;

  @IsOptional() @IsString() @Matches(DOOR_PRICE)
  unitPrice?: string | null;
}

@Roles('admin')
@Controller('door-designs')
export class DoorDesignsController {
  constructor(private readonly catalog: DoorDesignsService) {}

  @Get()
  list() { return this.catalog.list(); }

  @Patch(':id')
  edit(@Param('id', ParseIntPipe) id: number, @Body() data: UpdateDoorDesignDto) {
    return this.catalog.edit(id, data);
  }
}
