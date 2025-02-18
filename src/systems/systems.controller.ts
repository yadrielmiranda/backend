import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { SystemsService } from './systems.service';
import { CreateSystemDto } from './dto/create-system.dto';
import { UpdateSystemDto } from './dto/update-system.dto';
import { System as SystemModel} from '@prisma/client';

@Controller('systems')
export class SystemsController {
  constructor(private readonly systemsService: SystemsService) {}

  @Post()
  async createSystem(@Body() systemData: {name: string, idProduct: number}): Promise<SystemModel> {
    const {name, idProduct}  = systemData;
    return this.systemsService.createSystem(
        {
          name,
          prod:{
            connect:{id: idProduct}
          }
        }
      );  
  }

    @Get()
    async getAllUsers(): Promise<SystemModel[]> {
      return this.systemsService.systems({});
    }


  
}
