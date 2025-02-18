import { IsNotEmpty, IsString } from "class-validator";

export class CreateFrameColorDto {

    @IsString()
    @IsNotEmpty()
    color: string;
}
