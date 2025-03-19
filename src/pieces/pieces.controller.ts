import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { PiecesService } from './pieces.service';
import { CreatePieceDto } from './dto/create-piece.dto';
import { UpdatePieceDto } from './dto/update-piece.dto';
import { Piece as PieceModel} from '@prisma/client';

@Controller('pieces')
export class PiecesController {
  constructor(private readonly piecesService: PiecesService) {}

    @Post()
   async createPiece(
     @Body() pieceData: CreatePieceDto,
   ): Promise<PieceModel> {
     const { idEst, idProd, idBrand, idSyst, idConf, idFC, width, height, idCryst, idTint, privacy, idCoat, screen, muntin, price } = pieceData;
     return this.piecesService.createPiece({
      estim: {
        connect:{id: idEst}
      },
      prod:{
        connect:{ id: idProd}
      },
      bran:{
        connect:{ id: idBrand}
      },
       syst: {
         connect: { id: idSyst }  //Aqui es donde se verifica que exista ese idSys en la tabla System
       },
       conf: {
         connect: { id: idConf }    //Aqui es donde se verifica que exista ese id en la tabla Conf
       },
       fColor:{
        connect:{id: idFC}
       },
       cryst:{
        connect: {id: idCryst}
       },
       tin: {
        connect: {id: idTint}
       },
       coat:{
        connect: {id: idCoat}
       },
       width,
       height,       
       muntin,
       privacy,
       screen,
       price

     });
   }
 
   @Get()
   async getAllPiece(): Promise<PieceModel[]> {
     return this.piecesService.pieces({});
   }
 
   @Get(':id')
   async getPiece(@Param('id') id: string): Promise<PieceModel> {
     return this.piecesService.piece({ id: Number(id) });
   }
 
     @Patch(':id')
     async updatePiece(
       @Param('id') id: string,
       @Body() pieceData: UpdatePieceDto,
     ): Promise<PieceModel> {       
       return this.piecesService.updatePiece({
         where: { id: Number(id) },
         data: pieceData});
     }
 
   @Delete(':id')
   async deletePiece(@Param('id') id: string): Promise<PieceModel> {
     return this.piecesService.deletePiece({ id: Number(id) });
   }
}
