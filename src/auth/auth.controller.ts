// src/auth/auth.controller.ts

import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Res
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { Response } from 'express';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() loginDto: LoginDto, // Usa el DTO con 'identifier'
    @Res({ passthrough: true }) response: Response,
  ) {
    
    // Llamamos al método 'validateAndSignIn' y le pasamos el 'identifier'.
    const { access_token } = await this.authService.validateAndSignIn(
      loginDto.identifier, 
      loginDto.password
    );

    // Lógica de cookies 
    response.cookie('access_token', access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict', // 'strict' es generalmente más seguro que 'lax'
      maxAge: 3600000 * 24, // 24 horas
      path: '/',
    });

    
    return {
      message: 'Inicio de sesión exitoso',
    };
  }


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
}