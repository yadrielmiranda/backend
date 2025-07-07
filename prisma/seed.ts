import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

// Inicializa el cliente de Prisma
const prisma = new PrismaClient();

async function main() {
  console.log(`Start seeding ...`);

  // 1. Crear o actualizar los roles usando upsert
  // Esto es más robusto que createMany, ya que no depende del orden
  // y permite añadir o quitar roles fácilmente en el futuro.
  const rolesToCreate = ['admin', 'client', 'deler'];
  console.log('Upserting roles...');
  for (const roleName of rolesToCreate) {
    await prisma.role.upsert({
      where: { name: roleName },
      update: {},
      create: { name: roleName },
    });
  }
  console.log('Roles are up to date.');

  // 2. Crear un usuario administrador por defecto
  const saltRounds = 10;
  const hashedPassword = await bcrypt.hash('admin123', saltRounds); // ¡IMPORTANTE: Cambiar esta contraseña en producción!

  // Buscamos el rol de admin para obtener su ID dinámicamente
  const adminRole = await prisma.role.findUnique({
    where: { name: 'admin' },
  });

  if (!adminRole) {
    console.error('Admin role not found. Cannot create admin user.');
    return;
  }

  // Usamos 'upsert' para crear el usuario solo si no existe.
  await prisma.user.upsert({
    where: { username: 'admin' }, // Criterio para buscar si el usuario ya existe
    update: {}, // No hacemos nada si ya existe
    create: {
      username: 'admin',
      firstName: 'Admin',
      lastName: 'User',
      email: 'admin@example.com',
      phone: '1234567890',
      address: '123 Admin Street',
      password: hashedPassword,
      idRole: adminRole.id, // Asignamos el ID del rol de 'admin' dinámicamente
    },
  });

  console.log('Default admin user is up to date.');
  console.log(`Seeding finished.`);
}

// Ejecuta la función principal y maneja la desconexión
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    // Cierra la conexión a la base de datos
    await prisma.$disconnect();
  });
