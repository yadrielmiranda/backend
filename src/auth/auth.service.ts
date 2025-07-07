import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'src/prisma/prisma.service';
import { UsersService } from 'src/users/users.service';
import { RegisterUserDto } from './dto/register-user.dto';
import * as bcrypt from 'bcrypt';
import { User, Prisma } from '@prisma/client'; 

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async validateAndSignIn(
    identifier: string,
    pass: string,
  ): Promise<{ access_token: string }> {
    // Define el tipo de payload esperado para el usuario con el rol incluido
    type UserWithRolePayload = Prisma.UserGetPayload<{
      include: { role: true };
    }>;

    const user = (await this.usersService.findOneByIdentifier(identifier)) as UserWithRolePayload;

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas.');
    }

    const isPasswordMatching = await bcrypt.compare(pass, user.password);
    if (!isPasswordMatching) {
      throw new UnauthorizedException('Credenciales inválidas.');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password, ...result } = user;
    // Ahora 'user.role' es reconocido correctamente por TypeScript
    const payload = { sub: user.id, username: user.username, firstName: user.firstName, lastName: user.lastName, email: user.email, role: user.role};

    return {
      access_token: await this.jwtService.signAsync(payload),
    };
  }

  async registerUser(registerUserDto: RegisterUserDto): Promise<User> {
    const { password, ...userData } = registerUserDto;

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const clientRole = await this.prisma.role.findUnique({
      where: { name: 'client' },
    });
    if (!clientRole) {
      throw new InternalServerErrorException(
        "El rol por defecto 'client' no fue encontrado.",
      );
    }

    try {
      const user = await this.prisma.user.create({
        data: {
          ...userData,
          password: hashedPassword,
          role: {
            connect: { id: clientRole.id },
          },
        },
        include: {
          role: true, // Incluye el rol en la respuesta
        },
      });
      return user;
    } catch (error) {
      if (error.code === 'P2002') {
        throw new ConflictException('El nombre de usuario o el email ya existen.');
      }
      throw new InternalServerErrorException('No se pudo crear el usuario.');
    }
  }
}
