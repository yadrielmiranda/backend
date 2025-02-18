import { IsBoolean, IsEmail, IsNotEmpty, IsPhoneNumber, IsString } from "class-validator";

export class CreateUserDto {

    @IsNotEmpty()
    @IsString()                  
    username: string;  
    
    @IsNotEmpty()
    @IsString()                  
    firstName: string; 

    @IsNotEmpty()
    @IsString()                  
    lastName: string; 

    @IsNotEmpty()
    @IsEmail()                      
    email: string;  

    @IsNotEmpty()     
    @IsPhoneNumber('US')                
    phone: string; 
    
    @IsNotEmpty()
    @IsString()                  
    password: string; 

    @IsNotEmpty()
    @IsString()                  
    address: string; 
    
    @IsNotEmpty()
    @IsBoolean()                  
    admin: boolean;
 
}
