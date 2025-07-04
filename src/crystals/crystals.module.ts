import { Module } from '@nestjs/common';
import { CrystalService} from './crystals.service';
import { CrystalController} from './crystals.controller';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [CrystalController],
  providers: [CrystalService],
})
export class CrystalsModule { }
