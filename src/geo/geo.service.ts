// src/geo/geo.service.ts
import { Injectable } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { firstValueFrom } from "rxjs";

type ZipLookupResult = { city: string; state: string } | null;

type ZippopotamResponse = {
  "post code": string;
  country: string;
  "country abbreviation": string;
  places: Array<{
    "place name": string;
    state: string;
    "state abbreviation": string;
  }>;
};

@Injectable()
export class GeoService {
  // cache simple en memoria (opcional pero recomendado)
  private cache = new Map<string, { value: ZipLookupResult; expiresAt: number }>();
  private TTL_MS = 1000 * 60 * 60 * 24; // 24h

  constructor(private readonly http: HttpService) {}

  async lookupZip(zip5: string): Promise<ZipLookupResult> {
    const z = (zip5 ?? "").trim();
    if (!/^\d{5}$/.test(z)) return null;

    const cached = this.cache.get(z);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const url = `https://api.zippopotam.us/us/${z}`;

    try {
      const res = await firstValueFrom(
        this.http.get<ZippopotamResponse>(url, {
          // si no existe, zippopotam responde 404
          validateStatus: (status) => status === 200 || status === 404,
        })
      );

      if (res.status === 404) {
        this.cache.set(z, { value: null, expiresAt: Date.now() + this.TTL_MS });
        return null;
      }

      const place = res.data?.places?.[0];
      const city = place?.["place name"]?.trim();
      const state = place?.["state abbreviation"]?.trim();

      const value = city && state ? { city, state } : null;
      this.cache.set(z, { value, expiresAt: Date.now() + this.TTL_MS });
      return value;
    } catch {
      // si la API falla, no rompemos tu app
      return null;
    }
  }
}
