import { GlobalParameterKey, PrismaClient } from '@prisma/client';
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
    { name: 'operator', markup: 0.0 }, // 0%
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

    // 2.b Crear los estados de los estimates
  const estimateStatusesToCreate = ["Active", "Ordered", "Expired"];
  console.log("Upserting estimate statuses...");
  for (const statusName of estimateStatusesToCreate) {
    await prisma.estimateStatus.upsert({
      where: { name: statusName },
      update: {},
      create: { name: statusName },
    });
  }
  console.log("Estimate statuses are up to date.");


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
  where: { username: "admin" },
  update: {
    firstName: "Admin",
    lastName: "User",
    email: "admin@example.com",
    phone: "+13055550101",
    street: "123 Admin Street",
    city: "Miami",
    state: "FL",
    postalCode: "33101",
    idRole: adminRole.id,
    isTaxExempt: true,
  },
  create: {
    username: "admin",
    firstName: "Admin",
    lastName: "User",
    email: "admin@example.com",
    phone: "+13055550101",
    street: "123 Admin Street",
    city: "Miami",
    state: "FL",
    postalCode: "33101",
    password: hashedPassword,
    idRole: adminRole.id,
    isTaxExempt: true,
  },
});


  console.log('Default admin user is up to date.');

  // 4. Crear el parámetro de impuesto sobre ventas por defecto
  console.log('Upserting global parameters...');
  await prisma.globalParameter.upsert({
    where: { key: GlobalParameterKey.SALES_TAX },
    update: {}, // No hacemos nada si ya existe
    create: {
      key: GlobalParameterKey.SALES_TAX,
      value: 0.07, // Valor inicial del 7%
      description: 'Sales tax for the state of Florida.',
      unit: '%',
    },
  });
  console.log('Global parameters are up to date.');

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