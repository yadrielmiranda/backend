// src/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from 'src/users/users.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { JwtStrategy } from './guards/auth/jwt.strategy';

@Module({
  imports: [    
    ConfigModule,
    UsersModule,
    PrismaModule,
    PassportModule,

    // ✅ JWT usando .env (JWT_SECRET_KEY)
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET_KEY');
        if (!secret) {
          throw new Error('JWT_SECRET_KEY is not set in .env');
        }
        return {
          global: true, // si quieres que JwtService esté disponible global
          secret,
          signOptions: { expiresIn: '1d' },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
