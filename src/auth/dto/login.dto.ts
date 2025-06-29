import { IsNotEmpty, IsString, MinLength } from "class-validator";

export class LoginDto {

    @IsString()
    @IsNotEmpty({ message: 'The identifier cannot be empty.' })
    identifier: string;

    @IsString()
    @IsNotEmpty({ message: 'The password cannot be empty.' })
    @MinLength(8, { message: 'The password must be at least 8 characters.' })
    password: string;
}