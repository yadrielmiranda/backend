import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Res,
  UseGuards,
  Get,
  Req,
  Patch,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { Response, Request } from 'express';
import { RegisterUserDto } from './dto/register-user.dto';
import { JwtAuthGuard } from './guards/auth/auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { Public } from 'src/auth/public.decorator';
import { AuthUser } from './types/auth-user.type';
import { UsersService, UserSafe } from 'src/users/users.service'; // ✅ NEW

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService, // ✅ NEW
  ) {}

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { access_token } = await this.authService.validateAndSignIn(
      loginDto.identifier,
      loginDto.password,
    );

    response.cookie('access_token', access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 3600000 * 24, // 24 horas
      path: '/',
    });

    return { message: 'Inicio de sesión exitoso' };
  }

  // ✅ AHORA DEVUELVE EL USER SAFE REAL (incluye role.id)
  @UseGuards(JwtAuthGuard)
  @Get('profile')
  async getProfile(@Req() req: Request): Promise<UserSafe> {
    const userId = (req.user as AuthUser).id;
    return this.usersService.userSafe({ id: userId });
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Res({ passthrough: true }) response: Response) {
    response.cookie('access_token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      expires: new Date(0),
      path: '/',
    });

    return { message: 'Sesión cerrada exitosamente' };
  }

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() registerUserDto: RegisterUserDto) {
    return this.authService.registerUser(registerUserDto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('profile')
  async updateProfile(
    @Req() req: Request,
    @Body() updateProfileDto: UpdateProfileDto,
  ) {
    const userId = (req.user as AuthUser).id;
    return this.authService.updateProfile(userId, updateProfileDto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @Req() req: Request,
    @Body() changePasswordDto: ChangePasswordDto,
  ) {
    const userId = (req.user as AuthUser).id;
    return this.authService.changePassword(userId, changePasswordDto);
  }
}
