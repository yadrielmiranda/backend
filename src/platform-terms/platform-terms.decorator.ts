import { SetMetadata } from '@nestjs/common';

export const ALLOW_BEFORE_PLATFORM_TERMS = 'allowBeforePlatformTerms';
// Solo permite consultar/aceptar condiciones, mantener la sesión o salir.
export const AllowBeforePlatformTerms = () => SetMetadata(ALLOW_BEFORE_PLATFORM_TERMS, true);
