import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

// Inicializa el cliente de Prisma
const prisma = new PrismaClient();

async function main() {
  console.log(`Start seeding ...`);

  // 1. Crear o actualizar los roles
  const rolesToCreate = [
    { name: 'admin', markup: 0.0 },  // 0%
    { name: 'client', markup: 0.30 }, // 30%
    { name: 'dealer', markup: 0.15 }, // 15%
  ];
  console.log('Upserting roles...');
 for (const roleData of rolesToCreate) {
    await prisma.role.upsert({
      where: { name: roleData.name },
      update: { markup: roleData.markup }, // Actualiza el markup si el rol ya existe
      create: { name: roleData.name, markup: roleData.markup }, // Lo crea con el markup
    });
  }
  console.log('Roles are up to date.');

  // 2. Crear los estados de las órdenes 
  const orderStatusesToCreate = ['In production', 'Ready to pick up', 'Delivered'];
  console.log('Upserting order statuses...');
  for (const statusName of orderStatusesToCreate) {
    await prisma.orderStatus.upsert({
      where: { name: statusName },
      update: {},
      create: { name: statusName },
    });
  }
  console.log('Order statuses are up to date.');

  // 3. Crear un usuario administrador por defecto
  const saltRounds = 10;
  const hashedPassword = await bcrypt.hash('admin123', saltRounds); // ¡IMPORTANTE: Cambiar esta contraseña en producción!

  const adminRole = await prisma.role.findUnique({
    where: { name: 'admin' },
  });

  if (!adminRole) {
    console.error('Admin role not found. Cannot create admin user.');
    return;
  }

  await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      firstName: 'Admin',
      lastName: 'User',
      email: 'admin@example.com',
      phone: '1234567890',
      address: '123 Admin Street',
      password: hashedPassword,
      idRole: adminRole.id,
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