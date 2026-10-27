import { registerDecorator, ValidationOptions } from 'class-validator';

/** References are displayed by the browser; the server never fetches them. */
export function isSafeDesignPreviewReference(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\s\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith('/')) return !value.startsWith('//');
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function IsDesignPreviewReference(options?: ValidationOptions) {
  return (object: object, propertyName: string) => registerDecorator({
    name: 'isDesignPreviewReference', target: object.constructor, propertyName,
    options: { message: 'Use an HTTP/HTTPS image URL or a local path beginning with a single /.', ...options },
    validator: { validate: isSafeDesignPreviewReference },
  });
}
