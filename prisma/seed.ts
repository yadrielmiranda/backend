import { GlobalParameterKey, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

// Inicializa el cliente de Prisma
const prisma = new PrismaClient();

async function main() {
  console.log(`Start seeding ...`);

  // 1. Crear o actualizar los roles
  const rolesToCreate = [
    { name: 'admin', markup: 0.0 }, // 0%
    { name: 'client', markup: 0.30 }, // 30%
    { name: 'dealer', markup: 0.15 }, // 15%
    { name: 'operator', markup: 0.0 }, // 0%
  ];

  console.log('Upserting roles...');
  for (const roleData of rolesToCreate) {
    await prisma.role.upsert({
      where: { name: roleData.name },
      // no actualizamos roles existentes para no pisar markups reales en produccion.
      update: {},
      create: { name: roleData.name, markup: roleData.markup },
    });
  }
  console.log('Roles are up to date.');

  // 2. Crear los estados de las órdenes
  const orderStatusesToCreate = [
    'Pending',
    'In production',
    'Ready to pick up',
    'Delivered',
  ];

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
  const estimateStatusesToCreate = ['Active', 'Ordered', 'Expired'];

  console.log('Upserting estimate statuses...');
  for (const statusName of estimateStatusesToCreate) {
    await prisma.estimateStatus.upsert({
      where: { name: statusName },
      update: {},
      create: { name: statusName },
    });
  }
  console.log('Estimate statuses are up to date.');

  // 2.c Crear catálogos mínimos de muntin solo si están vacíos
  // comentario en espanol: estos valores son solo datos iniciales para una DB nueva.
  // Si el admin ya creó o renombró opciones desde el frontend, el seed no debe tocarlas.
  const muntinPatternsCount = await prisma.muntinPattern.count();

  if (muntinPatternsCount === 0) {
    console.log('Creating initial muntin patterns...');

    await prisma.muntinPattern.createMany({
      data: [
        {
          name: 'Full View',
          requiresLites: false,
          isActive: true,
          isDefault: true,
        },
        {
          name: 'Colonial',
          requiresLites: true,
          isActive: true,
          isDefault: false,
        },
      ],
    });

    console.log('Initial muntin patterns created.');
  } else {
    console.log('Muntin patterns already exist. Seed will not modify them.');
  }

  // 2.d Crear types mínimos de muntin solo si están vacíos
  // estos valores son solo datos iniciales para una DB nueva.
  // Si el admin ya creó o renombró opciones desde el frontend, el seed no debe tocarlas.
  const muntinTypesCount = await prisma.muntinType.count();

  if (muntinTypesCount === 0) {
    console.log('Creating initial muntin types...');

    await prisma.muntinType.createMany({
      data: [
        { name: 'None', isActive: true },
        { name: '1 in Flat-Flat', isActive: true },
        { name: '1 in Ogee-Flat', isActive: true },
      ],
    });

    console.log('Initial muntin types created.');
  } else {
    console.log('Muntin types already exist. Seed will not modify them.');
  }

  // 3. Crear un usuario administrador por defecto
  const saltRounds = 10;
  const hashedPassword = await bcrypt.hash('admin123', saltRounds);

  const adminRole = await prisma.role.findUnique({
    where: { name: 'admin' },
  });

  if (!adminRole) {
    console.error('Admin role not found. Cannot create admin user.');
    return;
  }

  await prisma.user.upsert({
    where: { username: 'admin' },
    // no actualizamos el admin existente para no pisar datos reales en produccion.
    update: {},
    create: {
      username: 'admin',
      firstName: 'Admin',
      lastName: 'User',
      email: 'admin@example.com',
      phone: '+13055550101',
      street: '123 Admin Street',
      city: 'Miami',
      state: 'FL',
      postalCode: '33101',
      password: hashedPassword,
      idRole: adminRole.id,
      isTaxExempt: true,
    },
  });

  console.log('Default admin user is up to date.');

  // 4. Crear o actualizar parámetros globales
  console.log('Upserting global parameters...');

  await prisma.globalParameter.upsert({
    where: { key: GlobalParameterKey.SALES_TAX },
    update: {},
    create: {
      key: GlobalParameterKey.SALES_TAX,
      value: 0.07,
      description: 'Sales tax for the state of Florida.',
      unit: '%',
    },
  });

  await prisma.globalParameter.upsert({
    where: { key: GlobalParameterKey.ESTIMATE_VALID_DAYS },
    update: {},
    create: {
      key: GlobalParameterKey.ESTIMATE_VALID_DAYS,
      value: 30,
      description: 'Number of days an estimate remains valid.',
      unit: 'days',
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
    await prisma.$disconnect();
  });