import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class WarehouseRequestDto {
  @IsUUID('4') requestKey: string;
}
export class WarehouseScanDto extends WarehouseRequestDto {
  @IsString() @Length(1, 60) barcode: string;
  @IsIn(['COLLECT', 'RECEIVE', 'RELEASE']) action:
    | 'COLLECT'
    | 'RECEIVE'
    | 'RELEASE';
  // null significa Unassigned solo para salidas; recoger no asigna un store.
  @IsOptional() @IsInt() @Min(1) storeId?: number | null;
}
export class WarehouseReceiptItemDto {
  @IsString() @Length(1, 60) barcode: string;
  @IsInt() @Min(1) @Max(200) quantity: number;
  @IsInt() @Min(0) version: number;
}
export class WarehouseReceiptDto extends WarehouseRequestDto {
  @IsInt() @Min(1) storeId: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500)
  @ValidateNested({ each: true }) @Type(() => WarehouseReceiptItemDto)
  items: WarehouseReceiptItemDto[];
}

export class WarehouseInstallationDeliveryDto extends WarehouseRequestDto {
  @IsInt() @Min(1) installationJobId: number;
  @IsString() @Length(1, 500) installationAddress: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500)
  @ValidateNested({ each: true }) @Type(() => WarehouseReceiptItemDto)
  items: WarehouseReceiptItemDto[];
}

export class FactoryPickupRunCreateDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50)
  @IsString({ each: true })
  poNumbers: string[];
}

export class FactoryPickupRunScanDto extends WarehouseRequestDto {
  @IsString() @Length(1, 60) barcode: string;
  @IsOptional() @IsBoolean() addPo?: boolean;
}

export class FactoryPickupRunFinishDto {
  @IsOptional()
  @IsIn([
    'NOT_READY_AT_FACTORY',
    'MANUFACTURER_HELD_MATERIAL',
    'DAMAGED_NOT_ACCEPTED',
    'OTHER',
  ])
  partialReason?:
    | 'NOT_READY_AT_FACTORY'
    | 'MANUFACTURER_HELD_MATERIAL'
    | 'DAMAGED_NOT_ACCEPTED'
    | 'OTHER';

  @IsOptional() @IsString() @Length(0, 500) note?: string;
}
export class WarehouseTransferDto extends WarehouseRequestDto {
  @IsString() @Length(1, 60) barcode: string;
  @IsOptional() @IsInt() @Min(1) fromStoreId: number | null;
  @IsInt() @Min(1) toStoreId: number;
  @IsInt() @Min(1) @Max(200) quantity: number;
  @IsInt() @Min(0) version: number;
}
export class WarehouseStoreCreateDto {
  @IsString() @Length(1, 80) name: string;
}
export class WarehouseStoreUpdateDto extends WarehouseStoreCreateDto {
  @IsBoolean() isActive: boolean;
  @IsInt() @Min(0) version: number;
}
export class WarehousePartsDto extends WarehouseRequestDto {
  @IsInt() @Min(1) @Max(200) expectedParts: number;
  @IsInt() @Min(0) version: number;
  @IsString() @Length(3, 500) reason: string;
}
export class WarehouseCountStartDto extends WarehouseRequestDto {
  @IsOptional() @IsIn(['ALL', 'STORE', 'UNASSIGNED'])
  scope?: 'ALL' | 'STORE' | 'UNASSIGNED';
  @IsOptional() @IsInt() @Min(1) storeId?: number | null;
}
export class WarehouseCountScanDto extends WarehouseRequestDto {
  @IsString() @Length(1, 60) barcode: string;
}
export class WarehouseCountCloseDto {
  @IsOptional() @IsString() @Length(64, 64) revision?: string;
  @IsIn(['COMPLETE', 'CANCEL']) action: 'COMPLETE' | 'CANCEL';
  @IsOptional() @IsString() @Length(3, 500) reason?: string;
}
