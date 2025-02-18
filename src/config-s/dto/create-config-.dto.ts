import { IsNotEmpty, IsString } from "class-validator";

export class CreateConfigDto {

    @IsString()
    @IsNotEmpty()
    conf: string;
}
