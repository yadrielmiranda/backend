import { IsNotEmpty, IsString } from "class-validator";

export class CreateSystemConfigDto {

    @IsString()
    @IsNotEmpty()
    idSys: string;

    @IsString()
    @IsNotEmpty()
    idConf: string;
}
