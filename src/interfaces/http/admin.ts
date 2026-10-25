import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { Context } from "hono";
import * as z from "@zod/zod";

import { auth } from "@/infrastructure/auth/auth.ts";
import { query } from "@/infrastructure/database/postgres.ts";
import { getAuthenticatedAppUser } from "@/interfaces/http/session.ts";
import { buildXlsxWorkbook } from "@/services/xlsx-export.ts";
import type { AppRole } from "@/domain/users.ts";

type AdminUserRow = {
  id: string;
  name: string;
  email: string;
  role: AppRole | null;
  document_number: string | null;
  institutional_code: string | null;
  is_active: boolean | null;
};

type ProgramRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
};

type AcademicSpaceRow = {
  id: string;
  program_id: string;
  program_name: string;
  code: string;
  name: string;
  description: string | null;
  credits: number | null;
  semester: number | null;
  is_active: boolean;
};

type AssignmentRow = {
  id: string;
  scope: "program" | "academic_space";
  relation: "student" | "teacher";
  target_id: string;
  target_name: string;
  user_id: string;
  user_name: string;
  user_email: string;
};

type AdminResultRow = {
  id: string;
  student_user_id: string;
  student_name: string;
  student_email: string;
  teacher_user_id: string;
  teacher_name: string;
  program_id: string;
  program_name: string;
  academic_space_id: string;
  academic_space_name: string;
  live_talk_id: string;
  live_talk_title: string;
  status: "in_progress" | "completed" | "cancelled";
  started_at: string;
  completed_at: string | null;
  final_score: string | null;
  evaluation_id: string | null;
  evaluation_status: "completed" | "failed" | null;
  evaluation_error: string | null;
  teacher_reviewed: boolean | null;
  teacher_override_grade: string | null;
};

type AdminResultMetricsRow = {
  total_attempts: string;
  completed_attempts: string;
  in_progress_attempts: string;
  cancelled_attempts: string;
  evaluated_attempts: string;
  reviewed_attempts: string;
  override_attempts: string;
  average_score: string | null;
};

type AdminResultGroupRow = {
  id: string;
  name: string;
  attempts_count: string;
  average_score: string | null;
};

type AdminAttemptDetailRow = AdminResultRow & {
  general_topic: string;
  rubric_version: string | null;
  evaluator_model: string | null;
  evaluator_model_version: string | null;
  teacher_override_reason: string | null;
  feedback_summary: string | null;
  strengths: string | null;
  improvement_opportunities: string | null;
  recommendations: string | null;
};

type AdminResultFilters = {
  programId: string | null;
  academicSpaceId: string | null;
  teacherUserId: string | null;
  studentUserId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
};

type AdminRubricItemRow = {
  id: string;
  topic: string | null;
  score: string;
  max_score: string;
  performance_level: string;
  evidence_turns: Array<{ turn_id: number; fragment: string }> | null;
  justification: string;
};

type AdminTranscriptTurnRow = {
  turn_id: number;
  speaker: "student" | "evaluator";
  text: string;
  occurred_at: string | null;
  source_message_id: string | null;
};

const roleSchema = z.enum(["admin", "docente", "estudiante"]);

const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  role: roleSchema,
  documentNumber: z.string().optional(),
  institutionalCode: z.string().optional(),
});

const updateUserSchema = z.object({
  name: z.string().min(2),
  role: roleSchema,
  documentNumber: z.string().optional(),
  institutionalCode: z.string().optional(),
  isActive: z.boolean(),
});

const programSchema = z.object({
  code: z.string().min(2),
  name: z.string().min(2),
  description: z.string().optional(),
  isActive: z.boolean().default(true),
});

const academicSpaceSchema = z.object({
  programId: z.uuid(),
  code: z.string().min(2),
  name: z.string().min(2),
  description: z.string().optional(),
  credits: z.number().int().min(0).max(30).optional(),
  semester: z.number().int().min(1).max(20).optional(),
  isActive: z.boolean().default(true),
});

const teacherAssignmentSchema = z.object({
  teacherUserId: z.string().min(1),
});

const studentAssignmentSchema = z.object({
  studentUserId: z.string().min(1),
});

export const adminRoutes = new Hono();

adminRoutes.use("*", async (c, next) => {
  const user = await getAuthenticatedAppUser(c);

  if (!user) {
    return c.json({ message: "No autenticado" }, 401);
  }

  if (!user.profile?.isActive || user.profile.role !== "admin") {
    return c.json({ message: "Solo administradores pueden acceder a este recurso" }, 403);
  }

  await next();
});

adminRoutes.get("/summary", async (c) => {
  const rows = await query<{
    users_count: string;
    programs_count: string;
    spaces_count: string;
    teacher_assignments_count: string;
    student_assignments_count: string;
  }>(
    `
      SELECT
        (SELECT COUNT(*) FROM user_profiles) AS users_count,
        (SELECT COUNT(*) FROM academic_programs) AS programs_count,
        (SELECT COUNT(*) FROM academic_spaces) AS spaces_count,
        (SELECT COUNT(*) FROM academic_space_teachers) AS teacher_assignments_count,
        (SELECT COUNT(*) FROM academic_space_students) AS student_assignments_count
    `,
  );

  const summary = rows[0];

  return c.json({
    summary: {
      users: Number(summary.users_count),
      programs: Number(summary.programs_count),
      spaces: Number(summary.spaces_count),
      assignments: Number(summary.teacher_assignments_count) +
        Number(summary.student_assignments_count),
    },
  });
});

adminRoutes.get("/users", async (c) => {
  const rows = await query<AdminUserRow>(
    `
      SELECT
        u.id,
        u.name,
        u.email,
        p.role,
        p.document_number,
        p.institutional_code,
        p.is_active
      FROM "user" u
      LEFT JOIN user_profiles p ON p.auth_user_id = u.id
      ORDER BY u."createdAt" DESC
    `,
  );

  return c.json({
    users: rows.map(formatAdminUser),
  });
});

adminRoutes.post(
  "/users",
  zValidator("json", createUserSchema),
  async (c) => {
    const body = c.req.valid("json");

    const created = await auth.api.signUpEmail({
      body: {
        name: body.name,
        email: body.email,
        password: body.password,
      },
    });

    await query(
      `
        INSERT INTO user_profiles (
          auth_user_id,
          role,
          document_number,
          institutional_code
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (auth_user_id)
        DO UPDATE SET
          role = EXCLUDED.role,
          document_number = EXCLUDED.document_number,
          institutional_code = EXCLUDED.institutional_code,
          is_active = TRUE,
          updated_at = now()
      `,
      [
        created.user.id,
        body.role,
        body.documentNumber ?? null,
        body.institutionalCode ?? null,
      ],
    );

    return c.json({ userId: created.user.id }, 201);
  },
);

adminRoutes.patch(
  "/users/:id",
  zValidator("json", updateUserSchema),
  async (c) => {
    const userId = c.req.param("id");
    const body = c.req.valid("json");

    await query(
      `
        UPDATE "user"
        SET name = $2, "updatedAt" = now()
        WHERE id = $1
      `,
      [userId, body.name],
    );

    await query(
      `
        INSERT INTO user_profiles (
          auth_user_id,
          role,
          document_number,
          institutional_code,
          is_active
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (auth_user_id)
        DO UPDATE SET
          role = EXCLUDED.role,
          document_number = EXCLUDED.document_number,
          institutional_code = EXCLUDED.institutional_code,
          is_active = EXCLUDED.is_active,
          updated_at = now()
      `,
      [
        userId,
        body.role,
        body.documentNumber ?? null,
        body.institutionalCode ?? null,
        body.isActive,
      ],
    );

    return c.json({ ok: true });
  },
);

adminRoutes.delete("/users/:id", async (c) => {
  const userId = c.req.param("id");

  try {
    await query(
      `
        DELETE FROM "user"
        WHERE id = $1
      `,
      [userId],
    );
  } catch (error) {
    return handleDeleteError(c, error, "No se puede eliminar el usuario porque tiene relaciones académicas o históricos asociados.");
  }

  return c.json({ ok: true });
});

adminRoutes.get("/programs", async (c) => {
  const rows = await query<ProgramRow>(
    `
      SELECT id::text, code, name, description, is_active
      FROM academic_programs
      ORDER BY name
    `,
  );

  return c.json({ programs: rows.map(formatProgram) });
});

adminRoutes.post(
  "/programs",
  zValidator("json", programSchema),
  async (c) => {
    const body = c.req.valid("json");
    const rows = await query<{ id: string }>(
      `
        INSERT INTO academic_programs (code, name, description, is_active)
        VALUES ($1, $2, $3, $4)
        RETURNING id::text
      `,
      [body.code, body.name, body.description ?? null, body.isActive],
    );

    return c.json({ id: rows[0].id }, 201);
  },
);

adminRoutes.patch(
  "/programs/:id",
  zValidator("json", programSchema),
  async (c) => {
    const id = c.req.param("id");
    const body = c.req.valid("json");

    await query(
      `
        UPDATE academic_programs
        SET
          code = $2,
          name = $3,
          description = $4,
          is_active = $5,
          updated_at = now()
        WHERE id = $1
      `,
      [id, body.code, body.name, body.description ?? null, body.isActive],
    );

    return c.json({ ok: true });
  },
);

adminRoutes.delete("/programs/:id", async (c) => {
  const id = c.req.param("id");

  try {
    await query(
      `
        DELETE FROM academic_programs
        WHERE id = $1
      `,
      [id],
    );
  } catch (error) {
    return handleDeleteError(c, error, "No se puede eliminar el programa porque tiene espacios académicos o estudiantes asociados.");
  }

  return c.json({ ok: true });
});

adminRoutes.get("/academic-spaces", async (c) => {
  const rows = await query<AcademicSpaceRow>(
    `
      SELECT
        s.id::text,
        s.program_id::text,
        p.name AS program_name,
        s.code,
        s.name,
        s.description,
        s.credits,
        s.semester,
        s.is_active
      FROM academic_spaces s
      JOIN academic_programs p ON p.id = s.program_id
      ORDER BY p.name, s.name
    `,
  );

  return c.json({ academicSpaces: rows.map(formatAcademicSpace) });
});

adminRoutes.get("/assignments", async (c) => {
  const rows = await query<AssignmentRow>(
    `
      SELECT
        CONCAT('program:', ps.program_id::text, ':student:', ps.student_user_id) AS id,
        'program'::text AS scope,
        'student'::text AS relation,
        p.id::text AS target_id,
        p.name AS target_name,
        u.id AS user_id,
        u.name AS user_name,
        u.email AS user_email
      FROM program_students ps
      JOIN academic_programs p ON p.id = ps.program_id
      JOIN "user" u ON u.id = ps.student_user_id

      UNION ALL

      SELECT
        CONCAT('space:', ast.academic_space_id::text, ':teacher:', ast.teacher_user_id) AS id,
        'academic_space'::text AS scope,
        'teacher'::text AS relation,
        s.id::text AS target_id,
        s.name AS target_name,
        u.id AS user_id,
        u.name AS user_name,
        u.email AS user_email
      FROM academic_space_teachers ast
      JOIN academic_spaces s ON s.id = ast.academic_space_id
      JOIN "user" u ON u.id = ast.teacher_user_id

      UNION ALL

      SELECT
        CONCAT('space:', ass.academic_space_id::text, ':student:', ass.student_user_id) AS id,
        'academic_space'::text AS scope,
        'student'::text AS relation,
        s.id::text AS target_id,
        s.name AS target_name,
        u.id AS user_id,
        u.name AS user_name,
        u.email AS user_email
      FROM academic_space_students ass
      JOIN academic_spaces s ON s.id = ass.academic_space_id
      JOIN "user" u ON u.id = ass.student_user_id

      ORDER BY scope, target_name, relation, user_name
    `,
  );

  return c.json({
    assignments: rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      relation: row.relation,
      targetId: row.target_id,
      targetName: row.target_name,
      userId: row.user_id,
      userName: row.user_name,
      userEmail: row.user_email,
    })),
  });
});

adminRoutes.get("/results/metrics", async (c) => {
  const filters = readAdminResultFilters(c);
  const params = adminResultFilterParams(filters);

  const metricRows = await query<AdminResultMetricsRow>(
    `
      SELECT
        COUNT(*)::text AS total_attempts,
        COUNT(*) FILTER (WHERE ea.status = 'completed')::text AS completed_attempts,
        COUNT(*) FILTER (WHERE ea.status = 'in_progress')::text AS in_progress_attempts,
        COUNT(*) FILTER (WHERE ea.status = 'cancelled')::text AS cancelled_attempts,
        COUNT(*) FILTER (WHERE ev.id IS NOT NULL)::text AS evaluated_attempts,
        COUNT(*) FILTER (WHERE gh.teacher_reviewed = TRUE)::text AS reviewed_attempts,
        COUNT(*) FILTER (WHERE gh.teacher_override_grade IS NOT NULL)::text AS override_attempts,
        AVG(COALESCE(gh.teacher_override_grade, ea.final_score))::text AS average_score
      FROM evaluation_attempts ea
      JOIN live_talks lt ON lt.id = ea.live_talk_id
      JOIN academic_spaces s ON s.id = lt.academic_space_id
      JOIN academic_programs p ON p.id = s.program_id
      LEFT JOIN LATERAL (
        SELECT *
        FROM evaluations current_ev
        WHERE current_ev.attempt_id = ea.id
        ORDER BY current_ev.created_at DESC
        LIMIT 1
      ) ev ON TRUE
      LEFT JOIN LATERAL (
        SELECT *
        FROM grade_history current_grade
        WHERE current_grade.evaluation_id = ev.id
        ORDER BY current_grade.recorded_at DESC
        LIMIT 1
      ) gh ON TRUE
      WHERE ($1::uuid IS NULL OR p.id = $1::uuid)
        AND ($2::uuid IS NULL OR s.id = $2::uuid)
        AND ($3::text IS NULL OR lt.created_by_teacher_user_id = $3::text)
        AND ($4::text IS NULL OR ea.student_user_id = $4::text)
        AND ($5::timestamptz IS NULL OR ea.started_at >= $5::timestamptz)
        AND ($6::timestamptz IS NULL OR ea.started_at < ($6::date + INTERVAL '1 day'))
    `,
    params,
  );

  const byProgramRows = await query<AdminResultGroupRow>(
    `
      SELECT
        p.id::text,
        p.name,
        COUNT(*)::text AS attempts_count,
        AVG(COALESCE(gh.teacher_override_grade, ea.final_score))::text AS average_score
      FROM evaluation_attempts ea
      JOIN live_talks lt ON lt.id = ea.live_talk_id
      JOIN academic_spaces s ON s.id = lt.academic_space_id
      JOIN academic_programs p ON p.id = s.program_id
      LEFT JOIN LATERAL (
        SELECT *
        FROM evaluations current_ev
        WHERE current_ev.attempt_id = ea.id
        ORDER BY current_ev.created_at DESC
        LIMIT 1
      ) ev ON TRUE
      LEFT JOIN LATERAL (
        SELECT *
        FROM grade_history current_grade
        WHERE current_grade.evaluation_id = ev.id
        ORDER BY current_grade.recorded_at DESC
        LIMIT 1
      ) gh ON TRUE
      WHERE ($1::uuid IS NULL OR p.id = $1::uuid)
        AND ($2::uuid IS NULL OR s.id = $2::uuid)
        AND ($3::text IS NULL OR lt.created_by_teacher_user_id = $3::text)
        AND ($4::text IS NULL OR ea.student_user_id = $4::text)
        AND ($5::timestamptz IS NULL OR ea.started_at >= $5::timestamptz)
        AND ($6::timestamptz IS NULL OR ea.started_at < ($6::date + INTERVAL '1 day'))
      GROUP BY p.id, p.name
      ORDER BY COUNT(*) DESC, p.name
      LIMIT 8
    `,
    params,
  );

  const bySpaceRows = await query<AdminResultGroupRow>(
    `
      SELECT
        s.id::text,
        s.name,
        COUNT(*)::text AS attempts_count,
        AVG(COALESCE(gh.teacher_override_grade, ea.final_score))::text AS average_score
      FROM evaluation_attempts ea
      JOIN live_talks lt ON lt.id = ea.live_talk_id
      JOIN academic_spaces s ON s.id = lt.academic_space_id
      JOIN academic_programs p ON p.id = s.program_id
      LEFT JOIN LATERAL (
        SELECT *
        FROM evaluations current_ev
        WHERE current_ev.attempt_id = ea.id
        ORDER BY current_ev.created_at DESC
        LIMIT 1
      ) ev ON TRUE
      LEFT JOIN LATERAL (
        SELECT *
        FROM grade_history current_grade
        WHERE current_grade.evaluation_id = ev.id
        ORDER BY current_grade.recorded_at DESC
        LIMIT 1
      ) gh ON TRUE
      WHERE ($1::uuid IS NULL OR p.id = $1::uuid)
        AND ($2::uuid IS NULL OR s.id = $2::uuid)
        AND ($3::text IS NULL OR lt.created_by_teacher_user_id = $3::text)
        AND ($4::text IS NULL OR ea.student_user_id = $4::text)
        AND ($5::timestamptz IS NULL OR ea.started_at >= $5::timestamptz)
        AND ($6::timestamptz IS NULL OR ea.started_at < ($6::date + INTERVAL '1 day'))
      GROUP BY s.id, s.name
      ORDER BY COUNT(*) DESC, s.name
      LIMIT 8
    `,
    params,
  );

  const metrics = metricRows[0];

  return c.json({
    metrics: {
      totalAttempts: Number(metrics.total_attempts),
      completedAttempts: Number(metrics.completed_attempts),
      inProgressAttempts: Number(metrics.in_progress_attempts),
      cancelledAttempts: Number(metrics.cancelled_attempts),
      evaluatedAttempts: Number(metrics.evaluated_attempts),
      reviewedAttempts: Number(metrics.reviewed_attempts),
      overrideAttempts: Number(metrics.override_attempts),
      averageScore: metrics.average_score === null ? null : roundNumber(Number(metrics.average_score)),
      byProgram: byProgramRows.map(formatAdminResultGroup),
      bySpace: bySpaceRows.map(formatAdminResultGroup),
    },
  });
});

adminRoutes.get("/results/export.csv", async (c) => {
  const filters = readAdminResultFilters(c);
  const rows = await query<AdminResultRow>(
    adminResultsQuery("ea.started_at DESC", 1000),
    adminResultFilterParams(filters),
  );

  const csv = buildResultsCsv(rows.map(formatAdminResult));

  return c.body(csv, 200, {
    "Content-Disposition": `attachment; filename="resultados-virtualchallenge-${new Date().toISOString().slice(0, 10)}.csv"`,
    "Content-Type": "text/csv; charset=utf-8",
  });
});

adminRoutes.get("/results/export.xlsx", async (c) => {
  const filters = readAdminResultFilters(c);
  const rows = await query<AdminResultRow>(
    adminResultsQuery("ea.started_at DESC", 1000),
    adminResultFilterParams(filters),
  );
  const workbook = buildXlsxWorkbook(buildResultsTable(rows.map(formatAdminResult)));

  return new Response(workbook as BodyInit, {
    status: 200,
    headers: {
      "Content-Disposition": `attachment; filename="resultados-virtualchallenge-${new Date().toISOString().slice(0, 10)}.xlsx"`,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  });
});

adminRoutes.get("/results", async (c) => {
  const filters = readAdminResultFilters(c);

  const rows = await query<AdminResultRow>(
    adminResultsQuery("ea.started_at DESC", 250),
    adminResultFilterParams(filters),
  );

  return c.json({
    results: rows.map(formatAdminResult),
  });
});

adminRoutes.get("/attempts/:id", async (c) => {
  const id = c.req.param("id");
  const attemptRows = await query<AdminAttemptDetailRow>(
    `
      SELECT
        ea.id::text,
        ea.student_user_id,
        student.name AS student_name,
        student.email AS student_email,
        lt.created_by_teacher_user_id AS teacher_user_id,
        teacher.name AS teacher_name,
        p.id::text AS program_id,
        p.name AS program_name,
        s.id::text AS academic_space_id,
        s.name AS academic_space_name,
        lt.id::text AS live_talk_id,
        lt.title AS live_talk_title,
        lt.general_topic,
        ea.status,
        ea.started_at::text,
        ea.completed_at::text,
        ea.final_score::text,
        ev.id::text AS evaluation_id,
        ev.status AS evaluation_status,
        ev.error_message AS evaluation_error,
        ev.rubric_version,
        ev.evaluator_model,
        ev.evaluator_model_version,
        gh.teacher_reviewed,
        gh.teacher_override_grade::text,
        gh.teacher_override_reason,
        ef.summary AS feedback_summary,
        ef.strengths,
        ef.improvement_opportunities,
        ef.recommendations
      FROM evaluation_attempts ea
      JOIN "user" student ON student.id = ea.student_user_id
      JOIN live_talks lt ON lt.id = ea.live_talk_id
      JOIN "user" teacher ON teacher.id = lt.created_by_teacher_user_id
      JOIN academic_spaces s ON s.id = lt.academic_space_id
      JOIN academic_programs p ON p.id = s.program_id
      LEFT JOIN LATERAL (
        SELECT *
        FROM evaluations current_ev
        WHERE current_ev.attempt_id = ea.id
        ORDER BY current_ev.created_at DESC
        LIMIT 1
      ) ev ON TRUE
      LEFT JOIN evaluation_feedback ef ON ef.evaluation_id = ev.id
      LEFT JOIN LATERAL (
        SELECT *
        FROM grade_history current_grade
        WHERE current_grade.evaluation_id = ev.id
        ORDER BY current_grade.recorded_at DESC
        LIMIT 1
      ) gh ON TRUE
      WHERE ea.id = $1
    `,
    [id],
  );

  const attempt = attemptRows[0];

  if (!attempt) {
    return c.json({ message: "Intento no encontrado" }, 404);
  }

  const rubricRows = attempt.evaluation_id
    ? await query<AdminRubricItemRow>(
      `
        SELECT
          id::text,
          topic,
          score::text,
          max_score::text,
          performance_level,
          evidence_turns,
          justification
        FROM evaluation_rubric_items
        WHERE evaluation_id = $1
        ORDER BY created_at, topic
      `,
      [attempt.evaluation_id],
    )
    : [];

  const transcriptRows = await query<AdminTranscriptTurnRow>(
    `
      SELECT
        turn_id,
        speaker,
        text,
        occurred_at::text,
        source_message_id
      FROM evaluation_transcript_turns
      WHERE attempt_id = $1
      ORDER BY turn_id
    `,
    [id],
  );

  return c.json({
    attempt: {
      ...formatAdminResult(attempt),
      generalTopic: attempt.general_topic,
      rubricVersion: attempt.rubric_version,
      evaluatorModel: attempt.evaluator_model,
      evaluatorModelVersion: attempt.evaluator_model_version,
      teacherOverrideReason: attempt.teacher_override_reason,
      feedback: attempt.feedback_summary === null
        ? null
        : {
          summary: attempt.feedback_summary,
          strengths: attempt.strengths,
          improvementOpportunities: attempt.improvement_opportunities,
          recommendations: attempt.recommendations,
        },
      rubricItems: rubricRows.map((row) => ({
        id: row.id,
        topic: row.topic,
        score: Number(row.score),
        maxScore: Number(row.max_score),
        performanceLevel: row.performance_level,
        evidence: row.evidence_turns ?? [],
        justification: row.justification,
      })),
      transcript: transcriptRows.map((row) => ({
        turnId: row.turn_id,
        speaker: row.speaker,
        text: row.text,
        occurredAt: row.occurred_at,
        sourceMessageId: row.source_message_id,
      })),
    },
  });
});

adminRoutes.post(
  "/academic-spaces",
  zValidator("json", academicSpaceSchema),
  async (c) => {
    const body = c.req.valid("json");
    const rows = await query<{ id: string }>(
      `
        INSERT INTO academic_spaces (
          program_id,
          code,
          name,
          description,
          credits,
          semester,
          is_active
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id::text
      `,
      [
        body.programId,
        body.code,
        body.name,
        body.description ?? null,
        body.credits ?? null,
        body.semester ?? null,
        body.isActive,
      ],
    );

    return c.json({ id: rows[0].id }, 201);
  },
);

adminRoutes.patch(
  "/academic-spaces/:id",
  zValidator("json", academicSpaceSchema),
  async (c) => {
    const id = c.req.param("id");
    const body = c.req.valid("json");

    await query(
      `
        UPDATE academic_spaces
        SET
          program_id = $2,
          code = $3,
          name = $4,
          description = $5,
          credits = $6,
          semester = $7,
          is_active = $8,
          updated_at = now()
        WHERE id = $1
      `,
      [
        id,
        body.programId,
        body.code,
        body.name,
        body.description ?? null,
        body.credits ?? null,
        body.semester ?? null,
        body.isActive,
      ],
    );

    return c.json({ ok: true });
  },
);

adminRoutes.delete("/academic-spaces/:id", async (c) => {
  const id = c.req.param("id");

  try {
    await query(
      `
        DELETE FROM academic_spaces
        WHERE id = $1
      `,
      [id],
    );
  } catch (error) {
    return handleDeleteError(c, error, "No se puede eliminar el espacio académico porque tiene docentes, estudiantes, live talks o notas asociadas.");
  }

  return c.json({ ok: true });
});

adminRoutes.post(
  "/programs/:programId/students",
  zValidator("json", studentAssignmentSchema),
  async (c) => {
    const programId = c.req.param("programId");
    const body = c.req.valid("json");

    await query(
      `
        INSERT INTO program_students (program_id, student_user_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `,
      [programId, body.studentUserId],
    );

    return c.json({ ok: true }, 201);
  },
);

adminRoutes.delete("/programs/:programId/students/:studentUserId", async (c) => {
  await query(
    `
      DELETE FROM program_students
      WHERE program_id = $1 AND student_user_id = $2
    `,
    [c.req.param("programId"), c.req.param("studentUserId")],
  );

  return c.json({ ok: true });
});

adminRoutes.post(
  "/academic-spaces/:spaceId/teachers",
  zValidator("json", teacherAssignmentSchema),
  async (c) => {
    const spaceId = c.req.param("spaceId");
    const body = c.req.valid("json");

    await query(
      `
        INSERT INTO academic_space_teachers (academic_space_id, teacher_user_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `,
      [spaceId, body.teacherUserId],
    );

    return c.json({ ok: true }, 201);
  },
);

adminRoutes.delete("/academic-spaces/:spaceId/teachers/:teacherUserId", async (c) => {
  await query(
    `
      DELETE FROM academic_space_teachers
      WHERE academic_space_id = $1 AND teacher_user_id = $2
    `,
    [c.req.param("spaceId"), c.req.param("teacherUserId")],
  );

  return c.json({ ok: true });
});

adminRoutes.post(
  "/academic-spaces/:spaceId/students",
  zValidator("json", studentAssignmentSchema),
  async (c) => {
    const spaceId = c.req.param("spaceId");
    const body = c.req.valid("json");

    await query(
      `
        INSERT INTO academic_space_students (academic_space_id, student_user_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `,
      [spaceId, body.studentUserId],
    );

    return c.json({ ok: true }, 201);
  },
);

adminRoutes.delete("/academic-spaces/:spaceId/students/:studentUserId", async (c) => {
  await query(
    `
      DELETE FROM academic_space_students
      WHERE academic_space_id = $1 AND student_user_id = $2
    `,
    [c.req.param("spaceId"), c.req.param("studentUserId")],
  );

  return c.json({ ok: true });
});

function formatAdminUser(row: AdminUserRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    documentNumber: row.document_number,
    institutionalCode: row.institutional_code,
    isActive: row.is_active ?? false,
  };
}

function formatProgram(row: ProgramRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isActive: row.is_active,
  };
}

function formatAcademicSpace(row: AcademicSpaceRow) {
  return {
    id: row.id,
    programId: row.program_id,
    programName: row.program_name,
    code: row.code,
    name: row.name,
    description: row.description,
    credits: row.credits,
    semester: row.semester,
    isActive: row.is_active,
  };
}

function formatAdminResult(row: AdminResultRow) {
  return {
    id: row.id,
    studentUserId: row.student_user_id,
    studentName: row.student_name,
    studentEmail: row.student_email,
    teacherUserId: row.teacher_user_id,
    teacherName: row.teacher_name,
    programId: row.program_id,
    programName: row.program_name,
    academicSpaceId: row.academic_space_id,
    academicSpaceName: row.academic_space_name,
    liveTalkId: row.live_talk_id,
    liveTalkTitle: row.live_talk_title,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    finalScore: row.final_score === null ? null : Number(row.final_score),
    evaluationId: row.evaluation_id,
    evaluationStatus: row.evaluation_status,
    evaluationError: row.evaluation_error,
    teacherReviewed: row.teacher_reviewed ?? false,
    teacherOverrideGrade: row.teacher_override_grade === null
      ? null
      : Number(row.teacher_override_grade),
  };
}

function formatAdminResultGroup(row: AdminResultGroupRow) {
  return {
    id: row.id,
    name: row.name,
    attemptsCount: Number(row.attempts_count),
    averageScore: row.average_score === null ? null : roundNumber(Number(row.average_score)),
  };
}

function readAdminResultFilters(c: Context): AdminResultFilters {
  return {
    programId: normalizeOptionalParam(c.req.query("programId")),
    academicSpaceId: normalizeOptionalParam(c.req.query("academicSpaceId")),
    teacherUserId: normalizeOptionalParam(c.req.query("teacherUserId")),
    studentUserId: normalizeOptionalParam(c.req.query("studentUserId")),
    dateFrom: normalizeOptionalParam(c.req.query("dateFrom")),
    dateTo: normalizeOptionalParam(c.req.query("dateTo")),
  };
}

function adminResultFilterParams(filters: AdminResultFilters) {
  return [
    filters.programId,
    filters.academicSpaceId,
    filters.teacherUserId,
    filters.studentUserId,
    filters.dateFrom,
    filters.dateTo,
  ];
}

function adminResultsQuery(orderBy: string, limit: number) {
  return `
    SELECT
      ea.id::text,
      ea.student_user_id,
      student.name AS student_name,
      student.email AS student_email,
      lt.created_by_teacher_user_id AS teacher_user_id,
      teacher.name AS teacher_name,
      p.id::text AS program_id,
      p.name AS program_name,
      s.id::text AS academic_space_id,
      s.name AS academic_space_name,
      lt.id::text AS live_talk_id,
      lt.title AS live_talk_title,
      ea.status,
      ea.started_at::text,
      ea.completed_at::text,
      ea.final_score::text,
      ev.id::text AS evaluation_id,
      ev.status AS evaluation_status,
      ev.error_message AS evaluation_error,
      gh.teacher_reviewed,
      gh.teacher_override_grade::text
    FROM evaluation_attempts ea
    JOIN "user" student ON student.id = ea.student_user_id
    JOIN live_talks lt ON lt.id = ea.live_talk_id
    JOIN "user" teacher ON teacher.id = lt.created_by_teacher_user_id
    JOIN academic_spaces s ON s.id = lt.academic_space_id
    JOIN academic_programs p ON p.id = s.program_id
    LEFT JOIN LATERAL (
      SELECT *
      FROM evaluations current_ev
      WHERE current_ev.attempt_id = ea.id
      ORDER BY current_ev.created_at DESC
      LIMIT 1
    ) ev ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM grade_history current_grade
      WHERE current_grade.evaluation_id = ev.id
      ORDER BY current_grade.recorded_at DESC
      LIMIT 1
    ) gh ON TRUE
    WHERE ($1::uuid IS NULL OR p.id = $1::uuid)
      AND ($2::uuid IS NULL OR s.id = $2::uuid)
      AND ($3::text IS NULL OR lt.created_by_teacher_user_id = $3::text)
      AND ($4::text IS NULL OR ea.student_user_id = $4::text)
      AND ($5::timestamptz IS NULL OR ea.started_at >= $5::timestamptz)
      AND ($6::timestamptz IS NULL OR ea.started_at < ($6::date + INTERVAL '1 day'))
    ORDER BY ${orderBy}
    LIMIT ${limit}
  `;
}

function buildResultsCsv(rows: Array<ReturnType<typeof formatAdminResult>>) {
  const table = buildResultsTable(rows);
  const lines = table.map((row) => row.map(csvCell).join(","));

  return lines.join("\n");
}

function buildResultsTable(rows: Array<ReturnType<typeof formatAdminResult>>) {
  const headers = [
    "id",
    "estudiante",
    "correo_estudiante",
    "docente",
    "programa",
    "espacio_academico",
    "live_talk",
    "estado",
    "nota_calculada",
    "nota_override_docente",
    "revisado_docente",
    "inicio",
    "finalizacion",
  ];

  return [
    headers,
    ...rows.map((row) => [
      row.id,
      row.studentName,
      row.studentEmail,
      row.teacherName,
      row.programName,
      row.academicSpaceName,
      row.liveTalkTitle,
      row.status,
      row.finalScore ?? "",
      row.teacherOverrideGrade ?? "",
      row.teacherReviewed ? "si" : "no",
      row.startedAt,
      row.completedAt ?? "",
    ]),
  ];
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function roundNumber(value: number) {
  return Math.round(value * 100) / 100;
}

function normalizeOptionalParam(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

function handleDeleteError(
  c: Context,
  error: unknown,
  message: string,
) {
  if (isPostgresError(error, "23503")) {
    return c.json({ message }, 409);
  }

  if (isPostgresError(error, "23505")) {
    return c.json({ message: "La operación viola una restricción de unicidad." }, 409);
  }

  console.error(error);
  return c.json({ message: "No fue posible completar la operación." }, 500);
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: string }).code === code;
}
