import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

export class MaterialRequestDto {
  @IsUUID('4') requestKey: string;
}
export class MaterialUnitCreateDto extends MaterialRequestDto {
  @IsString() @Length(1, 80) name: string;
}
export class MaterialUnitUpdateDto extends MaterialRequestDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
export class MaterialCategoryCreateDto extends MaterialRequestDto {
  @IsString() @Length(1, 80) name: string;
}
export class MaterialCategoryUpdateDto extends MaterialRequestDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
export class MaterialProductCreateDto extends MaterialRequestDto {
  @IsString() @Length(1, 200) name: string;
  @IsOptional() @IsString() @Length(0, 5000) description?: string;
  @IsOptional() @IsInt() @Min(1) categoryId?: number | null;
  @IsOptional() @IsString() @Length(0, 120) brand?: string | null;
  @IsOptional() @IsString() @Length(0, 255) imageUrl?: string | null;
  @IsInt() @Min(1) baseUnitId: number;
  @IsOptional() @IsString() @Length(0, 120) baseBarcode?: string;
  @IsInt() @Min(1) purchaseUnitId: number;
  @IsInt() @Min(1) @Max(1000000) purchaseMultiplier: number;
  @IsOptional() @IsString() @Length(0, 120) purchaseBarcode?: string;
}
export class MaterialProductUpdateDto extends MaterialRequestDto {
  @IsInt() @Min(0) version: number;
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @IsString() @Length(0, 5000) description?: string;
  @IsOptional() @IsInt() @Min(1) categoryId?: number | null;
  @IsOptional() @IsString() @Length(0, 120) brand?: string | null;
  @IsOptional() @IsString() @Length(0, 255) imageUrl?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() isSaleEnabled?: boolean;
}
export class MaterialPresentationCreateDto extends MaterialRequestDto {
  @IsInt() @Min(1) unitId: number;
  @IsInt() @Min(1) @Max(1000000) multiplier: number;
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsString() @Length(0, 120) barcode?: string;
  @IsOptional() @IsBoolean() generateBarcode?: boolean;
  @IsOptional() @IsBoolean() isPurchase?: boolean;
  @IsOptional() @IsBoolean() isSaleEnabled?: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99999999.99) salePrice?: number;
}
export class MaterialPresentationUpdateDto extends MaterialRequestDto {
  @IsInt() @Min(0) version: number;
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsString() @Length(0, 120) barcode?: string;
  @IsOptional() @IsBoolean() generateBarcode?: boolean;
  @IsOptional() @IsBoolean() isPurchase?: boolean;
  @IsOptional() @IsBoolean() isSaleEnabled?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99999999.99) salePrice?: number;
}
export class MaterialPresentationDeleteDto extends MaterialRequestDto {
  @IsInt() @Min(0) version: number;
}
export class MaterialStockRequestDto extends MaterialRequestDto {
  @IsInt() @Min(1) productId: number;
  @IsInt() @Min(1) presentationId: number;
  @IsInt() @Min(1) storeId: number;
  @IsInt() @Min(1) @Max(1000000) quantity: number;
  @IsOptional() @IsString() @Length(0, 1000) note?: string;
}
export class MaterialReceiptDto extends MaterialStockRequestDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99999999.99) costPerPackage: number;
  @IsOptional() @IsString() @Length(0, 200) supplier?: string;
  @IsOptional() @IsString() @Length(0, 200) reference?: string;
}
export class MaterialInternalUseDto extends MaterialStockRequestDto {
  @IsString() @Length(1, 200) recipient: string;
  @IsString() @Length(1, 1000) note: string;
}
export class MaterialRepackDto extends MaterialStockRequestDto {
  @IsIn(['OPEN', 'PACK']) action: 'OPEN' | 'PACK';
}
export class MaterialTransferDto extends MaterialRequestDto {
  @IsInt() @Min(1) productId: number;
  @IsInt() @Min(1) presentationId: number;
  @IsInt() @Min(1) fromStoreId: number;
  @IsInt() @Min(1) toStoreId: number;
  @IsInt() @Min(1) @Max(1000000) quantity: number;
  @IsOptional() @IsString() @Length(0, 1000) note?: string;
}
export class MaterialAdjustmentDto extends MaterialRequestDto {
  @IsInt() @Min(1) productId: number;
  @IsInt() @Min(1) presentationId: number;
  @IsInt() @Min(1) storeId: number;
  @IsInt() @Min(0) @Max(1000000) quantity: number;
  @IsInt() @Min(0) version: number;
  @IsString() @Length(1, 1000) note: string;
}
