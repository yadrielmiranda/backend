import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString } from "class-validator";

export class CreateConfigDto {

    @IsString()
    @IsNotEmpty()
    conf: string;

    @IsNumber()
    @IsNotEmpty()
    idProduct: number;

    @IsOptional() @IsBoolean() requiresWidth?: boolean;
    @IsOptional() @IsBoolean() requiresHeight?: boolean;
    @IsOptional() @IsBoolean() requiresHeightLeft?: boolean;
    @IsOptional() @IsBoolean() requiresHeightRight?: boolean;
    @IsOptional() @IsBoolean() requiresLegHeight?: boolean;
}
