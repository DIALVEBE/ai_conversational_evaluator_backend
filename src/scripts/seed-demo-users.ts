import { auth } from "@/infrastructure/auth/auth.ts";
import { pool, query } from "@/infrastructure/database/postgres.ts";
import {
  upsertUserProfile,
} from "@/repositories/user-profile-repository.ts";
import type { AppRole } from "@/domain/users.ts";

type DemoUser = {
  name: string;
  email: string;
  password: string;
  role: AppRole;
  documentNumber: string;
  institutionalCode: string;
};

const demoPassword = "Demo2026!";

const demoUsers: DemoUser[] = [
  {
    name: "Admin Demo",
    email: "admin.demo@virtualchallenge.edu",
    password: demoPassword,
    role: "admin",
    documentNumber: "1000000001",
    institutionalCode: "ADM-001",
  },
  {
    name: "Docente Demo",
    email: "docente.demo@virtualchallenge.edu",
    password: demoPassword,
    role: "docente",
    documentNumber: "1000000002",
    institutionalCode: "DOC-001",
  },
  {
    name: "Estudiante Demo",
    email: "estudiante.demo@virtualchallenge.edu",
    password: demoPassword,
    role: "estudiante",
    documentNumber: "1000000003",
    institutionalCode: "EST-001",
  },
];

type AuthUserRow = {
  id: string;
};

async function ensureAuthUser(user: DemoUser): Promise<string> {
  const existing = await query<AuthUserRow>(
    `SELECT id FROM "user" WHERE email = $1`,
    [user.email],
  );

  if (existing[0]) {
    return existing[0].id;
  }

  const result = await auth.api.signUpEmail({
    body: {
      name: user.name,
      email: user.email,
      password: user.password,
    },
  });

  return result.user.id;
}

async function seedAcademicStructure(input: {
  teacherUserId: string;
  studentUserId: string;
}) {
  const programRows = await query<{ id: string }>(
    `
      INSERT INTO academic_programs (code, name, description)
      VALUES (
        'ING-SIS',
        'Ingenieria de Sistemas',
        'Programa académico demo para pruebas de VirtualChallenge'
      )
      ON CONFLICT (code)
      DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        updated_at = now()
      RETURNING id
    `,
  );

  const programId = programRows[0].id;

  const spaceRows = await query<{ id: string }>(
    `
      INSERT INTO academic_spaces (
        program_id,
        code,
        name,
        description,
        credits,
        semester
      )
      VALUES (
        $1,
        'BD-101',
        'Bases de Datos',
        'Espacio académico demo para live talks',
        3,
        2
      )
      ON CONFLICT (program_id, code)
      DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        credits = EXCLUDED.credits,
        semester = EXCLUDED.semester,
        updated_at = now()
      RETURNING id
    `,
    [programId],
  );

  const academicSpaceId = spaceRows[0].id;

  await query(
    `
      INSERT INTO program_students (program_id, student_user_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `,
    [programId, input.studentUserId],
  );

  await query(
    `
      INSERT INTO academic_space_teachers (academic_space_id, teacher_user_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `,
    [academicSpaceId, input.teacherUserId],
  );

  await query(
    `
      INSERT INTO academic_space_students (academic_space_id, student_user_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `,
    [academicSpaceId, input.studentUserId],
  );
}

async function main() {
  const idsByRole = new Map<AppRole, string>();

  for (const demoUser of demoUsers) {
    const authUserId = await ensureAuthUser(demoUser);

    await upsertUserProfile({
      authUserId,
      role: demoUser.role,
      documentNumber: demoUser.documentNumber,
      institutionalCode: demoUser.institutionalCode,
    });

    idsByRole.set(demoUser.role, authUserId);
  }

  await seedAcademicStructure({
    teacherUserId: idsByRole.get("docente")!,
    studentUserId: idsByRole.get("estudiante")!,
  });

  console.log("Demo users seeded");
  console.log("Password for all demo users: Demo2026!");
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    await pool.end();
  }
}
