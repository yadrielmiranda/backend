import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Res,
  UnauthorizedException,
  UseGuards, // Si vas a proteger rutas en el futuro
  Get // Para un posible endpoint de prueba o para Logout
} from '@nestjs/common';
import { AuthService } from './auth.service'; // Importa tu AuthService
import { LoginDto } from './dto/login.dto'; // Importa tu DTO para el login
import { Response } from 'express'; // Necesitas el tipo Response de express para manejar cookies

@Controller('auth') // Todas las rutas en este controlador comenzarán con /auth
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Maneja la solicitud de login del usuario.
   * Valida las credenciales y establece la cookie de autenticación HttpOnly.
   */
  @HttpCode(HttpStatus.OK) // Asegura que la respuesta sea 200 OK en éxito
  @Post('login')
  async login(
    @Body() loginDto: LoginDto, // Obtiene los datos del cuerpo de la solicitud (username, password)
    @Res({ passthrough: true }) response: Response, // Permite que NestJS gestione la respuesta después de establecer la cookie
  ) {
    try {
      // Llama al servicio de autenticación para validar las credenciales y obtener el token/usuario
      const { access_token} = await this.authService.login(loginDto.username, loginDto.password);

      // Establece la cookie 'access_token' en la respuesta del navegador
      // ¡ATENCIÓN: Revisa los parámetros 'secure' y 'sameSite' para tu entorno!
      response.cookie('access_token', access_token, {
        httpOnly: true, // Hace que la cookie no sea accesible por JavaScript en el navegador (seguridad)
        secure: process.env.NODE_ENV === 'production', // Solo envía la cookie sobre HTTPS en producción
        sameSite: 'lax', // Protección CSRF básica. 'none' si necesitas full cross-site con secure:true
        maxAge: 3600000 * 24, // Duración de la cookie (ej. 24 horas en milisegundos)
        path: '/', // La cookie estará disponible para todas las rutas de tu frontend
        
      });

      console.log(`[AuthController] Login exitoso. Cookie establecida.`);

      // Retorna los datos públicos del usuario y un mensaje de éxito al frontend
      return {
        message: 'Inicio de sesión exitoso',        
      };
    } catch (error) {
      // Manejo de errores específicos, como credenciales inválidas
      if (error instanceof UnauthorizedException) {
        throw new UnauthorizedException('Credenciales inválidas.');
      }
      // Re-lanza cualquier otro error inesperado
      console.error("[AuthController] Error durante el login:", error);
      throw error;
    }
  }

  /**
   * Maneja la solicitud de logout del usuario.
   * Elimina la cookie de autenticación.
   */
  @HttpCode(HttpStatus.OK)
  @Post('logout') // Esta ruta será POST /auth/logout
  async logout(@Res({ passthrough: true }) response: Response) {
    // Elimina la cookie de autenticación estableciendo su expiración a una fecha pasada
    response.cookie('access_token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      expires: new Date(0), // Establece la fecha de expiración en el pasado
      path: '/',
      
    });

    console.log("[AuthController] Logout exitoso. Cookie 'access_token' eliminada.");
    return { message: 'Sesión cerrada exitosamente' };
  }

  // Si tienes una estrategia JWT para proteger rutas de tu backend, podrías tener un endpoint protegido así:
  /*
  @UseGuards(AuthGuard('jwt')) // Requiere que el token JWT sea válido
  @Get('profile') // Esta ruta será GET /auth/profile
  getProfile(@Request() req) {
    // El usuario se adjunta al objeto de solicitud por la estrategia JWT
    return req.user;
  }
  */
}