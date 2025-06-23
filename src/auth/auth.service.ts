import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UsersService } from 'src/users/users.service';

@Injectable()
export class AuthService {

  constructor(private usersService: UsersService,
    private jwtService: JwtService
  ) { }

  async login(username: string, pass: string): Promise<{ access_token: string }> {
    const user = await this.usersService.user({ username });
    console.log("ESTE ES EL USER");
    console.log(user);
    
    
    const isMatch = await bcrypt.compare(pass, user.password);


    if (!isMatch) {
      throw new UnauthorizedException();
    }
    const payload = { userID: user.id, userName: user.username, userFirstName: user.firstName, userLastName: user.lastName, userEmail: user.email };
    return {
      access_token: await this.jwtService.signAsync(payload),
     
    }



  }
}
