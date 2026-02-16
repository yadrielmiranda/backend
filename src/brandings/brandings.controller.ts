import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { join } from "path";
import * as fs from "fs";

import { BrandingsService } from "./brandings.service";
import { CreateBrandingDto } from "./dto/create-branding.dto";
import { UpdateBrandingDto } from "./dto/update-branding.dto";
import { Roles } from "src/auth/roles.decorator";

const UPLOAD_DIR = join(process.cwd(), "uploads", "logos");

// ✅ Comentarios en español (como pediste)
function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function extFromMime(mime: string): string | null {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  return null;
}

function deleteSameBaseFiles(baseName: string) {
  ensureUploadDir();
  const files = fs.readdirSync(UPLOAD_DIR);
  for (const f of files) {
    if (f.startsWith(baseName + ".")) {
      try {
        fs.unlinkSync(join(UPLOAD_DIR, f));
      } catch {
        // no-op
      }
    }
  }
}

function logoInterceptor(getBaseName: (req: any) => string) {
  ensureUploadDir();

  return FileInterceptor("file", {
    storage: diskStorage({
      destination: (_req, _file, cb) => {
        ensureUploadDir();
        cb(null, UPLOAD_DIR);
      },
      filename: (req, file, cb) => {
        try {
          if (!file.mimetype?.startsWith("image/")) {
            return cb(new BadRequestException("Only image files are allowed") as any, "");
          }

          const ext = extFromMime(file.mimetype);
          if (!ext) {
            return cb(
              new BadRequestException("Allowed formats: PNG, JPG, WEBP") as any,
              "",
            );
          }

          const baseName = getBaseName(req);

          // ✅ Evita acumulación: company.* o dealer-<id>.*
          deleteSameBaseFiles(baseName);

          cb(null, `${baseName}${ext}`);
        } catch (err) {
          cb(
            (err instanceof BadRequestException
              ? err
              : new BadRequestException("Invalid upload")) as any,
            "",
          );
        }
      },
    }),
    fileFilter: (_req, file, cb) => {
      if (!file.mimetype?.startsWith("image/")) {
        return cb(new BadRequestException("Only image files are allowed") as any, false);
      }
      cb(null, true);
    },
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  });
}

@Controller("brandings")
export class BrandingsController {
  constructor(private readonly service: BrandingsService) {}

  // =====================================================
  // COMPANY (ADMIN/OPERATOR read, ADMIN write)
  // =====================================================

  @Get("company")
  @Roles("admin", "operator")
  getCompany() {
    return this.service.getCompanyBranding();
  }

  @Post("company")
  @Roles("admin")
  createCompany(@Body() dto: CreateBrandingDto) {
    return this.service.createCompanyBranding(dto);
  }

  @Patch("company")
  @Roles("admin")
  updateCompany(@Body() dto: UpdateBrandingDto) {
    return this.service.updateCompanyBranding(dto);
  }

  // ✅ Upload logo COMPANY (archivo fijo: company.xxx)
  @Post("company/logo")
  @Roles("admin")
  @UseInterceptors(logoInterceptor(() => "company"))
  uploadCompanyLogo(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("Invalid image file.");

    const host = req.get("host");
    const protocol = req.protocol;
    const baseUrl = `${protocol}://${host}/uploads/logos/${file.filename}`;

    // ✅ cache-busting solo para el browser (NO lo guardes en DB)
    return { logoUrl: `${baseUrl}?v=${Date.now()}` };
  }

  // =====================================================
  // DEALER (su propio branding)
  // =====================================================

  @Get("me")
  @Roles("dealer")
  getDealer(@Req() req: any) {
    return this.service.getDealerBranding(req.user.id);
  }

  @Post("me")
  @Roles("dealer")
  createDealer(@Req() req: any, @Body() dto: CreateBrandingDto) {
    return this.service.createDealerBranding(req.user.id, dto);
  }

  @Patch("me")
  @Roles("dealer")
  updateDealer(@Req() req: any, @Body() dto: UpdateBrandingDto) {
    return this.service.updateDealerBranding(req.user.id, dto);
  }

  // ✅ Upload logo DEALER (archivo fijo por dealer: dealer-<id>.xxx)
  @Post("me/logo")
  @Roles("dealer")
  @UseInterceptors(
    logoInterceptor((req) => {
      const id = Number(req?.user?.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new BadRequestException("Missing req.user.id");
      }
      return `dealer-${id}`;
    }),
  )
  uploadDealerLogo(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("Invalid image file.");

    const host = req.get("host");
    const protocol = req.protocol;
    const baseUrl = `${protocol}://${host}/uploads/logos/${file.filename}`;

    return { logoUrl: `${baseUrl}?v=${Date.now()}` };
  }
}
