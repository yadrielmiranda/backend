# Valores energéticos por pieza

La pantalla **Settings → Energy Ratings** mantiene U-factor, SHGC y VLT por combinación de serie, cristal, tint, coating, privacidad y configuración. Utiliza los IDs actuales; los nombres se muestran para facilitar la selección. La migración agrega una tabla `energy_ratings` y dos campos opcionales en `Piece`: `energyRatingId` y `energySnapshot`. No se guardan metadatos del documento de origen ni una composición duplicada del cristal.

Los administradores pueden agregar, editar y desactivar registros; los operadores pueden consultar el catálogo. Una combinación puede tener una configuración concreta o un alcance para todas las configuraciones confirmado por el administrador. Una coincidencia concreta tiene prioridad sobre ese alcance general. No se permiten dos registros activos con la misma combinación y alcance.

## Estimados y revisiones

- Las piezas nuevas guardan los valores disponibles y la combinación seleccionada. También se guardan los casos sin coincidencia como `Data unavailable`; no se convierten en cero.
- Cambiar cristal, tint, coating, privacidad, serie o configuración busca una nueva coincidencia. Cambiar dimensiones, cantidad, precio o nombre visible conserva el snapshot correspondiente a la misma selección.
- Los estimados anteriores permanecen sin valores hasta usar **Update Energy Values**, o cambiar su selección energética. El botón requiere un estimado editable y actualiza únicamente los campos energéticos, sin recalcular precios ni planes de pago.
- Las piezas muestran los valores en la edición, los reportes y el PDF. Los materiales lineales no muestran valores energéticos.
- Las revisiones guardan los valores de su propuesta. Aplicar una revisión aprobada conserva esos valores aunque el catálogo haya cambiado después. Las revisiones anteriores a esta función conservan su ausencia de datos.
- Los enlaces públicos muestran los valores. Los documentos aprobados consideran los valores visibles para detectar cambios de contenido.

Se guardan únicamente los valores numéricos de U-factor, SHGC y VLT, sin un campo de unidades en el catálogo ni en los snapshots de las piezas. SHGC/VLT son fracciones de 0 a 1. Se almacenan seis decimales y se muestran tres, sin convertir los valores del Excel. Son valores documentados para la combinación; la aplicación no calcula un resultado a partir del tamaño ni declara una certificación independiente.

## Carga inicial

El procedimiento reproducible y sus criterios están en [energy-ratings-import.md](energy-ratings-import.md). La carga local inicial incorporó 207 combinaciones provenientes de 92 filas del Excel, para las series 375, 400, 450, 585 y 595. Las otras filas quedan en el informe de pendientes por falta de valores, composición no coincidente, contradicciones o alcance de configuración sin confirmar. Grey (Turtle) y Black permanecen sin datos y no se habilitan en ninguna marca.

La verificación local comparó 21 conjuntos de datos antes y después de migrar e importar: las 565 piezas existentes, estimados, precios y catálogos conservaron sus datos anteriores. El VPS no forma parte de esa carga local.
