import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from 'src/users/users.module';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { jwtConstants } from './constantesw';
import { JwtStrategy } from './guards/auth/jwt.strategy';
import { PrismaModule } from 'src/prisma/prisma.module'; // ¡Importa PrismaModule aquí!

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.register({
      global: true,
      secret: jwtConstants.secret,
      signOptions: { expiresIn: '1d' }
    }),
    PrismaModule, // ¡Asegúrate de importar PrismaModule para que PrismaService esté disponible!
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy
  ],
  exports: [AuthService]
})
export class AuthModule {}
