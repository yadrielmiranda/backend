import { IsNotEmpty, IsNumber} from "class-validator";

export class CreateSystemConfigDto {

    @IsNumber()
    @IsNotEmpty()
    idSys: number;

    @IsNumber()
    @IsNotEmpty()
    idConf: number;
}
