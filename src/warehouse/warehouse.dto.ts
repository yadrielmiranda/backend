import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

export class WarehouseRequestDto {
  @IsUUID('4') requestKey: string;
}
export class WarehouseScanDto extends WarehouseRequestDto {
  @IsString() @Length(1, 60) barcode: string;
  @IsIn(['COLLECT', 'RECEIVE', 'RELEASE']) action:
    | 'COLLECT'
    | 'RECEIVE'
    | 'RELEASE';
}
export class WarehousePartsDto extends WarehouseRequestDto {
  @IsInt() @Min(1) @Max(200) expectedParts: number;
  @IsInt() @Min(0) version: number;
  @IsString() @Length(3, 500) reason: string;
}
export class WarehouseCountScanDto extends WarehouseRequestDto {
  @IsString() @Length(1, 60) barcode: string;
}
export class WarehouseCountCloseDto {
  @IsOptional() @IsString() @Length(64, 64) revision?: string;
  @IsIn(['COMPLETE', 'CANCEL']) action: 'COMPLETE' | 'CANCEL';
  @IsOptional() @IsString() @Length(3, 500) reason?: string;
}
