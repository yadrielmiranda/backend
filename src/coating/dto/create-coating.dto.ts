import { IsNotEmpty, IsString } from "class-validator";

export class CreateCoatingDto {

    @IsString()
    @IsNotEmpty()
    name: string;
}
