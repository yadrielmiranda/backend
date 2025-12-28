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
import { Prisma } from '@prisma/client';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

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
    // 🔐 Este método necesita password => usa findOneByIdentifier (auth select)
    const user = await this.usersService.findOneByIdentifier(identifier);

    if (!user) throw new UnauthorizedException('Credenciales inválidas.');

    const isPasswordMatching = await bcrypt.compare(pass, user.password);
    if (!isPasswordMatching)
      throw new UnauthorizedException('Credenciales inválidas.');

    // ✅ payload simple: role como string (tu RolesGuard ya soporta string)
    const payload = {
      sub: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role?.name,
    };

    return {
      access_token: await this.jwtService.signAsync(payload),
    };
  }

  async registerUser(registerUserDto: RegisterUserDto) {
    const { password, ...userData } = registerUserDto;
    const hashedPassword = await bcrypt.hash(password, 10);

    const clientRole = await this.prisma.role.findUnique({
      where: { name: 'client' },
      select: { id: true },
    });

    if (!clientRole) {
      throw new InternalServerErrorException(
        "El rol por defecto 'client' no fue encontrado.",
      );
    }

    try {
      // ✅ SAFE SELECT: nunca devolvemos password aquí
      return await this.prisma.user.create({
        data: {
          ...userData,
          password: hashedPassword,
          role: { connect: { id: clientRole.id } },
        },
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          street: true,
          city: true,
          state: true,
          postalCode: true,
          markupOverride: true,
          isTaxExempt: true,
          idRole: true,
          role: {
            select: { id: true, name: true, markup: true },
          },
        },
      });
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw new ConflictException(
          'El nombre de usuario o el email ya existen.',
        );
      }
      throw new InternalServerErrorException('No se pudo crear el usuario.');
    }
  }

  async updateProfile(userId: number, data: UpdateProfileDto) {
    // usersService.updateUser ya devuelve SAFE (sin password)
    return this.usersService.updateUser({
      where: { id: userId },
      data,
    });
  }

    async changePassword(userId: number, changePasswordDto: ChangePasswordDto) {
  const user = await this.usersService.userWithPassword({ id: userId });

  const isPasswordMatching = await bcrypt.compare(
    changePasswordDto.currentPassword,
    user.password,
  );

  if (!isPasswordMatching) {
    throw new UnauthorizedException('La contraseña actual es incorrecta.');
  }

  const hashed = await bcrypt.hash(changePasswordDto.newPassword, 10);

  await this.usersService.updateUser({
    where: { id: userId },
    data: { password: hashed },
  });

  return { message: 'Contraseña actualizada exitosamente.' };
}


}
