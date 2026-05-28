import { Controller, Get, Param } from '@nestjs/common';
import { EstimatePublicShareService } from './estimate-public-share.service';
import { Public } from '@/auth/public.decorator';


@Public()
@Controller('public/estimates')
export class PublicEstimatesController {
    constructor(
        private readonly estimatePublicShareService: EstimatePublicShareService,
    ) { }

    @Get(':token')
    findByToken(@Param('token') token: string) {
        return this.estimatePublicShareService.findPublicEstimateByToken(token);
    }
}