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
import { extname, join } from "path";
import { randomUUID } from "crypto";
import * as fs from "fs";

import { BrandingsService } from "./brandings.service";
import { CreateBrandingDto } from "./dto/create-branding.dto";
import { UpdateBrandingDto } from "./dto/update-branding.dto";
import { Roles } from "@/auth/roles.decorator";

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

function dealerLogoBaseName(req: any): string {
  const id = Number(req?.user?.id);

  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestException("Missing req.user.id");
  }

  return `dealer-${id}`;
}

function logoFileNameFromUrl(
  logoUrl?: string | null,
): string | null {
  if (!logoUrl) return null;

  try {
    const pathname = new URL(
      logoUrl,
      "http://localhost",
    ).pathname;

    const uploadsPrefix = "/uploads/logos/";
    const prefixIndex = pathname.lastIndexOf(uploadsPrefix);

    if (prefixIndex < 0) return null;

    const fileName = decodeURIComponent(
      pathname.slice(prefixIndex + uploadsPrefix.length),
    );

    if (
      !fileName ||
      fileName.includes("/") ||
      fileName.includes("\\")
    ) {
      return null;
    }

    return fileName;
  } catch {
    return null;
  }
}

function isLogoFileForBase(
  fileName: string,
  baseName: string,
): boolean {
  const extension = extname(fileName).toLowerCase();

  if (
    ![".png", ".jpg", ".jpeg", ".webp"].includes(extension)
  ) {
    return false;
  }

  const fileNameWithoutExtension = fileName.slice(
    0,
    -extension.length,
  );

  return (
    fileNameWithoutExtension === baseName ||
    fileNameWithoutExtension.startsWith(`${baseName}-`)
  );
}

function deleteReplacedLogoFile(
  baseName: string,
  previousLogoUrl?: string | null,
  currentLogoUrl?: string | null,
): void {
  const previousFileName =
    logoFileNameFromUrl(previousLogoUrl);

  const currentFileName =
    logoFileNameFromUrl(currentLogoUrl);

  if (
    !previousFileName ||
    previousFileName === currentFileName
  ) {
    return;
  }

  if (!isLogoFileForBase(previousFileName, baseName)) {
    return;
  }

  const previousFilePath = join(
    UPLOAD_DIR,
    previousFileName,
  );

  try {
    fs.unlinkSync(previousFilePath);
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;

    if (fileError.code !== "ENOENT") {
      console.warn(
        `Could not delete replaced logo: ${previousFilePath}`,
        error,
      );
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

          const uniqueFileName =
            `${baseName}-${Date.now()}-${randomUUID()}${ext}`;

          cb(null, uniqueFileName);
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
  constructor(private readonly service: BrandingsService) { }

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
  async updateCompany(@Body() dto: UpdateBrandingDto) {
    const previous =
      await this.service.getCompanyBranding();

    const saved =
      await this.service.updateCompanyBranding(dto);

    deleteReplacedLogoFile(
      "company",
      previous?.logoUrl,
      saved.logoUrl,
    );

    return saved;
  }

  // Upload logo COMPANY using a unique file name
  @Post("company/logo")
  @Roles("admin")
  @UseInterceptors(logoInterceptor(() => "company"))
  uploadCompanyLogo(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("Invalid image file.");

    const host = req.get("host");
    const protocol = req.protocol;
    const baseUrl = `${protocol}://${host}/uploads/logos/${file.filename}`;

    // cache-busting solo para el browser (NO lo guardes en DB)
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
  async updateDealer(
    @Req() req: any,
    @Body() dto: UpdateBrandingDto,
  ) {
    const userId = Number(req.user.id);
    const baseName = dealerLogoBaseName(req);

    const previous =
      await this.service.getDealerBranding(userId);

    const saved =
      await this.service.updateDealerBranding(
        userId,
        dto,
      );

    deleteReplacedLogoFile(
      baseName,
      previous?.logoUrl,
      saved.logoUrl,
    );

    return saved;
  }

  // Upload logo DEALER using a unique file name per upload
  @Post("me/logo")
  @Roles("dealer")
  @UseInterceptors(
    logoInterceptor(dealerLogoBaseName),
  )
  uploadDealerLogo(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("Invalid image file.");

    const host = req.get("host");
    const protocol = req.protocol;
    const baseUrl = `${protocol}://${host}/uploads/logos/${file.filename}`;

    return { logoUrl: `${baseUrl}?v=${Date.now()}` };
  }
}
