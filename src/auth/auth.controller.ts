// @/auth/auth.controller.ts
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
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { Response, Request, CookieOptions } from 'express';
import { RegisterUserDto } from './dto/register-user.dto';
import { JwtAuthGuard } from '@/auth/guards/auth/auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { Public } from '@/auth/public.decorator';
import { AuthUser } from './types/auth-user.type';
import { UsersService, UserSafe } from '@/users/users.service';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './auth.tokens';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) { }

  private cookieOptions(maxAgeMs: number): CookieOptions {
    const isProd = process.env.NODE_ENV === 'production';

    return {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: maxAgeMs,
      path: '/',
      domain: isProd
        ? process.env.COOKIE_DOMAIN : undefined,
    };
  }

  private clearCookieOptions(): CookieOptions {
    const isProd = process.env.NODE_ENV === 'production';

    return {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      expires: new Date(0),
      maxAge: 0,
      path: '/',
      domain: isProd
        ? process.env.COOKIE_DOMAIN
        : undefined,
    };
  }


  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request,
  ) {
    const user = await this.authService.validateUser(
      loginDto.identifier,
      loginDto.password,
    );

    const accessToken = await this.authService.signAccessToken(user);

    const sessionId = this.authService.newSessionId();
    const refreshToken = await this.authService.signRefreshToken(
      user.id,
      sessionId,
    );

    // crea sesión + LOG LOGIN dentro del service
    await this.authService.createSession({
      sessionId,
      userId: user.id,
      refreshToken,
      userAgent: req.headers['user-agent'] as string | undefined,
      ip: req.ip as string | undefined,
    });

    res.cookie(ACCESS_COOKIE, accessToken, this.cookieOptions(1000 * 60 * 15)); // 15m
    res.cookie(
      REFRESH_COOKIE,
      refreshToken,
      this.cookieOptions(1000 * 60 * 60 * 24 * 30), // 30d
    );

    return { message: 'Inicio de sesión exitoso' };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    if (!refreshToken) throw new UnauthorizedException('No autenticado.');

    const { accessToken, newRefreshToken } =
      await this.authService.refreshFromToken(refreshToken);

    res.cookie(ACCESS_COOKIE, accessToken, this.cookieOptions(1000 * 60 * 15));
    res.cookie(
      REFRESH_COOKIE,
      newRefreshToken,
      this.cookieOptions(1000 * 60 * 60 * 24 * 30),
    );

    return { message: 'Token refrescado' };
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  async getProfile(@Req() req: Request): Promise<UserSafe> {
    const userId = (req.user as AuthUser).id;
    return this.usersService.userSafe({ id: userId });
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    if (refreshToken) {
      // ✅ revoca + LOG LOGOUT dentro del service
      await this.authService.revokeByRefreshToken(refreshToken, {
        reason: 'USER_LOGOUT',
        source: 'AuthController.logout',
      });
    }

    res.clearCookie(ACCESS_COOKIE, this.clearCookieOptions());
    res.clearCookie(REFRESH_COOKIE, this.clearCookieOptions());

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
    @Res({ passthrough: true }) res: Response,
    @Body() changePasswordDto: ChangePasswordDto,
  ) {
    const userId = (req.user as AuthUser).id;

    const currentRefresh = req.cookies?.[REFRESH_COOKIE] as string | undefined;

    const result = await this.authService.changePasswordSelf(
      userId,
      changePasswordDto,
      currentRefresh,
    );

    if (result.accessToken) {
      res.cookie(
        ACCESS_COOKIE,
        result.accessToken,
        this.cookieOptions(1000 * 60 * 15),
      );
    }

    if (result.refreshToken) {
      res.cookie(
        REFRESH_COOKIE,
        result.refreshToken,
        this.cookieOptions(1000 * 60 * 60 * 24 * 30),
      );
    }

    return { message: result.message };
  }
}
