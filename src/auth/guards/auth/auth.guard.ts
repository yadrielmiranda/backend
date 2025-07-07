import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

// Usamos el nombre 'jwt' que definimos en la estrategia
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
