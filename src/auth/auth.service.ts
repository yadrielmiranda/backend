import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UsersService } from 'src/users/users.service';

@Injectable()
export class AuthService {

  constructor(
    private usersService: UsersService,
    private jwtService: JwtService
  ) { }

  async validateAndSignIn(identifier: string, pass: string): Promise<{ access_token: string }> {
    // 1. Usamos la nueva función 'findOneByIdentifier' que busca por username O email.
    const user = await this.usersService.findOneByIdentifier(identifier);

    // 2. (MUY IMPORTANTE) Verificamos si el usuario existe ANTES de intentar comparar la contraseña.
    //    Si no existe, lanzamos el mismo error para no dar pistas a posibles atacantes.
    if (!user) {
      throw new UnauthorizedException('Incorrect credentials');
    }

    // 3. Comparamos la contraseña que nos llega con la hasheada en la BD.
    const isMatch = await bcrypt.compare(pass, user.password);

    // 4. Si la contraseña no coincide, lanzamos el error.
    if (!isMatch) {
      throw new UnauthorizedException('Incorrect credentials');
    }

    // 5. Creamos el payload para el JWT. Es buena práctica usar 'sub' para el ID de usuario.
   const payload = { 
    sub: user.id, 
    username: user.username, 
    email: user.email,
    firstName: user.firstName, 
    lastName: user.lastName,  
};

    // 6. Firmamos y devolvemos el token para que el AuthController lo pueda poner en una cookie.
    return {
      access_token: await this.jwtService.signAsync(payload),
    };
  }
}