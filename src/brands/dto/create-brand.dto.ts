import { Type } from "class-transformer";
import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from "class-validator";

export class CreateBrandDto {
    @IsNotEmpty()
    @IsString()
    name: string;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    highBottomPercent?: number | null;
}