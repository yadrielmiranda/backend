// @/geo/geo.controller.ts
import { Controller, Get, Param, BadRequestException } from "@nestjs/common";
import { GeoService } from "./geo.service";
import { Public } from "@/auth/public.decorator";

@Controller("geo")
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  // ✅ READ: todos los usuarios autenticados
  @Public()
  @Get("zip/:zip")
  async getByZip(@Param("zip") zip: string) {
    const zip5 = (zip ?? "").trim();
    if (!/^\d{5}$/.test(zip5)) throw new BadRequestException("Invalid ZIP");
    return this.geo.lookupZip(zip5);
  }
}
