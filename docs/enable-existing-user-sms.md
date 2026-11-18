# Activar las dos preferencias SMS de usuarios existentes

Script puntual: `scripts/enable-existing-user-sms.ts`. No agrega pantallas, endpoints ni una activación automática para cuentas futuras.

Desde la carpeta del **backend del VPS**, usa el administrador responsable de la activación. Para esta operación, el usuario indicado es `Anthony08540`. El script usa `DATABASE_URL` del entorno o del `.env` de ese backend.

Ver qué usuarios y categorías se activarían, sin escribir:

```sh
node -r ts-node/register scripts/enable-existing-user-sms.ts --admin Anthony08540
```

Aplicar las dos preferencias:

```sh
node -r ts-node/register scripts/enable-existing-user-sms.ts --admin Anthony08540 --apply
```

Usa las dependencias existentes del proyecto. No requiere migración.

El resultado muestra `mode` (`preview` o `applied`), los totales y el resultado por usuario y categoría:

- `ENABLE`: se activará en vista previa, o se activó al aplicar.
- `ALREADY_ENABLED`: conserva la preferencia, fecha y autorización existentes.
- `PREVIOUS_OPT_OUT`: conserva una baja previa de esa categoría.
- `STOP`: el teléfono tiene un bloqueo vigente.
- `PHONE_CHANGED`: el teléfono guardado en el consentimiento no coincide con el actual.
- `UNSUPPORTED_PHONE`, `INACTIVE` o `MISSING_USER`: cuenta no elegible.

Se activan por separado servicio y promociones para las cuentas existentes que sean elegibles. No se cambian teléfonos ni se quitan bloqueos o bajas. El usuario conserva la opción de desmarcar cualquiera de las dos casillas en su perfil.

`SmsConsent` y `SmsConsentEvent` guardan la autorización comunicada por el administrador con origen `ADMIN_SCRIPT`, su identificador/usuario, la fecha de registro y el programa SMS vigente. No se registra como un clic del usuario en `PROFILE` ni se inventa una fecha anterior de aceptación. Las categorías que ya están activadas conservan su evidencia original.

Preferencias e historial se guardan en una sola transacción. Repetir el script no vuelve a fechar ni duplicar las autorizaciones activas. Se vuelve a comprobar cada cuenta después de bloquear su fila para coordinar cambios simultáneos desde el perfil y bajas por STOP.

El script no envía mensajes, no crea SMS de bienvenida y no modifica las colas de envío. Tras aplicarlo, el portal podrá enviar los futuros avisos habilitados para cada usuario y categoría; no crea un motor de campañas promocionales.

Prueba local sin conexión a la base de datos:

```sh
node -r ts-node/register scripts/enable-existing-user-sms.spec.ts
```
