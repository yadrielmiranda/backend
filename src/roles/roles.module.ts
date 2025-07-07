import { Module } from '@nestjs/common';
import { RolesService } from './roles.service';
import { RolesController } from './roles.controller';
import { PrismaModule } from 'src/prisma/prisma.module'; // Importa PrismaModule

@Module({
  imports: [PrismaModule], // Añade PrismaModule a los imports
  controllers: [RolesController],
  providers: [RolesService],
})
export class RolesModule {}
