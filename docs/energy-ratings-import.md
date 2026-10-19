# Importación de valores energéticos

La importación agrega únicamente registros a `energy_ratings`, asociados por IDs a las series, cristales, tint, coating, privacidad y configuración existentes. No crea ni cambia esos catálogos, precios, diagramas o piezas anteriores. El Excel y su extracción JSON son entradas para comprobar las correspondencias. La base de datos de la aplicación no guarda archivo, hoja, fila, versión, código GL, composición ni notas de origen.

## Preparar y revisar

Ejecutar desde `backend` con Node.js y Python 3. El extractor utiliza únicamente la biblioteca estándar de Python y lee el Excel sin modificarlo.

```powershell
python scripts/extract-nfrc-energy.py 'RUTA/U factor ySHGC  NFRC_v0.9.xlsx' data/energy-ratings-nfrc-v0.9.json --version 0.9
node scripts/import-energy-ratings.cjs --dry-run --output ../outputs/energy-review
node --test scripts/energy-ratings-import.test.cjs
```

El modo predeterminado es `--dry-run`. Lee `DATABASE_URL` del entorno o de `backend/.env` usando el lector existente. Se permite únicamente una conexión local. Para revisar sin conexión puede utilizarse `--catalog RUTA/catalog.json`, con el objeto devuelto por `loadEnergyCatalog` o un contenedor `{ "catalog": ... }`. Un catálogo sin tint/coating/privacidad no sirve para aprobar una importación.

La carpeta de resultados contiene:

- `energy-summary.json`: cantidad de filas, coincidencias y motivos de exclusión.
- `energy-ready.json`: registros propuestos, con los IDs existentes y los valores energéticos, sin metadatos de origen.
- `energy-rejected.json` y `energy-rejected.csv`: filas pendientes con sus motivos.

## Criterios de correspondencia

La marca, serie y familia de producto deben coincidir. Se exige una asociación existente entre serie y cristal, así como opciones activas de tint/coating/privacidad asociadas a la marca. El indicador global de tint/coating por sí solo no sustituye la asociación que exige el servicio. Grey (Turtle) y Black no se activan ni reciben valores por similitud.

La comparación de composición conserva el orden y espesor de las capas, tratamiento HS/ANN/TEMP, espesor y material PVB/SGP, cámara y AIR/ARG. `FT` del fabricante se normaliza a `TEMP` (fully tempered). No se sustituye AIR por ARG, ni se supone tratamiento cuando la fuente no lo indica. Las propiedades separadas de tint, privacidad y SB70 se extraen comprobando que descripción y composición coincidan. La superficie SB70 se comprueba durante la importación. El nominal de un cristal laminado debe coincidir también con el rótulo del catálogo. Por ejemplo, la discrepancia 3/16 del catálogo frente a 5/16 del Excel se deja pendiente; el importador no corrige el catálogo.

Si dos composiciones de la fuente comparten los mismos selectores pero cambian la posición del tint o la superficie del coating, ambas quedan pendientes. La revisión incluye variantes que todavía no tienen valores numéricos. No se elige una composición simplemente porque sea la única que tenga valores disponibles.

Los bloques de producto se leen exclusivamente dentro del intervalo combinado de su celda. Las filas 422–437 no heredan el producto del bloque anterior. Se verifican automáticamente conflictos como el color de la fila 889 y la privacidad de la fila 924. Se excluyen las filas sin el conjunto completo de U-factor, SHGC y VLT. No se convierten vacíos ni guiones en cero; SHGC/VLT cero sí es un valor numérico válido.

## Alcance de configuraciones

Si la serie tiene una sola configuración activa existente se utiliza su ID. La serie 375 distingue explícitamente `P.WDW` (Picture Window) y `SHAPES`; se asignan únicamente los nombres de configuración conocidos de cada grupo. Una configuración nueva no recibe automáticamente esos valores.

Las demás series con varias configuraciones quedan pendientes hasta verificar el alcance con la fuente. Un manifiesto revisado puede seleccionar nombres exactos:

```json
{
  "100 SINGLE HUNG": {
    "configNames": ["NOMBRE EXACTO VERIFICADO"],
    "reason": "Documento y sección del fabricante que confirman este alcance"
  }
}
```

Pasarlo con `--verified-scope RUTA/scopes.json`. La alternativa `"allConfigs": true` requiere también una razón de verificación y crea un registro con alcance explícito para toda la serie. No debe utilizarse únicamente para eliminar pendientes. El importador no suministra ni aplica ese supuesto por defecto.

## Aplicar el resultado revisado

Después de desplegar la migración de la funcionalidad y generar el cliente Prisma:

```powershell
node scripts/import-energy-ratings.cjs --apply --target-host localhost --target-database impact --output ../outputs/energy-applied
```

El destino debe coincidir con la conexión real. El programa vuelve a leer el catálogo dentro de una transacción y genera nuevamente el plan. `--catalog` no puede utilizarse con `--apply`. Para otro equipo, ejecutar allí contra su conexión local después de la revisión y autorización de despliegue correspondientes.

Solo se insertan coincidencias completas. La operación es repetible: se comparan los IDs, el alcance y los tres valores numéricos. Las entradas iguales ya importadas se omiten aunque cambie el nombre del archivo o la fila del Excel. Una entrada activa diferente para la misma combinación detiene toda la transacción. Las entradas desactivadas no se reactivan; si sus valores difieren, la combinación requiere revisión. Nunca se sobreescribe una versión anterior ni se cambia el snapshot de una pieza. Una actualización debe revisarse y guardarse como una nueva versión mediante la administración de valores energéticos.

Los campos numéricos se guardan a seis decimales, conforme al esquema de la tabla, sin convertir los valores ni guardar un campo de unidades. Las representaciones originales del Excel se utilizan solamente como entrada de la importación. SHGC y VLT son proporciones de 0 a 1. La extracción inicial contiene 976 filas, de las cuales 750 tienen los tres valores numéricos. Ese total no equivale a 750 combinaciones aprobadas: el alcance de configuración y las diferencias de composición también deben resolverse.
