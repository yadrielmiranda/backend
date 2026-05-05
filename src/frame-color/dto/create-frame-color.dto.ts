import { IsBoolean, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class CreateFrameColorDto {

    @IsString()
    @IsNotEmpty()
    color: string;

    @IsOptional()
    @IsBoolean()
    isGlobal?: boolean;
}
