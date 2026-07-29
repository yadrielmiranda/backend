import { Transform } from "class-transformer";
import { IsNotEmpty, IsString, Matches } from "class-validator";

export class CreateTintDto {
    @IsString()
    @IsNotEmpty()
    color: string;

    @Transform(({ value }) =>
        typeof value === "string" ? value.trim().toUpperCase() : value,
    )
    @IsString()
    @Matches(/^#[0-9A-F]{6}$/, {
        message: "hexCode must use the format #RRGGBB.",
    })
    hexCode: string;
}