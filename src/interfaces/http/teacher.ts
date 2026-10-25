import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import * as z from "@zod/zod";

import { query } from "@/infrastructure/database/postgres.ts";
import { getAuthenticatedAppUser } from "@/interfaces/http/session.ts";

type TeacherSpaceRow = {
  id: string;
  code: string;
  name: string;
  program_id: string;
  program_name: string;
  students_count: string;
};

type LiveTalkRow = {
  id: string;
  academic_space_id: string;
  academic_space_name: string;
  title: string;
  general_topic: string;
  status: "draft" | "active" | "closed";
  opens_at: string | null;
  closes_at: string | null;
  created_at: string;
  topics: string[] | null;
};

type TeacherAttemptResultRow = {
  id: string;
  student_user_id: string;
  student_name: string;
  student_email: string;
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

type TeacherAttemptDetailRow = TeacherAttemptResultRow & {
  live_talk_id: string;
  live_talk_title: string;
  general_topic: string;
  academic_space_name: string;
  program_name: string;
  rubric_version: string | null;
  evaluator_model: string | null;
  evaluator_model_version: string | null;
  teacher_override_reason: string | null;
  feedback_summary: string | null;
  strengths: string | null;
  improvement_opportunities: string | null;
  recommendations: string | null;
};

type TeacherRubricItemRow = {
  id: string;
  topic: string | null;
  score: string;
  max_score: string;
  performance_level: string;
  evidence_turns: Array<{ turn_id: number; fragment: string }> | null;
  justification: string;
};

type TeacherTranscriptTurnRow = {
  turn_id: number;
  speaker: "student" | "evaluator";
  text: string;
  occurred_at: string | null;
  source_message_id: string | null;
};

type TeacherReviewContextRow = {
  attempt_id: string;
  evaluation_id: string | null;
  rubric_version: string | null;
  student_user_id: string;
  academic_space_id: string;
  live_talk_id: string;
  calculated_grade: string | null;
  evaluator_model: string | null;
  evaluator_model_version: string | null;
};

const liveTalkSchema = z.object({
  academicSpaceId: z.uuid(),
  title: z.string().min(3),
  generalTopic: z.string().min(3),
  topics: z.array(z.string().min(2)).min(1),
  opensAt: z.string().optional(),
  closesAt: z.string().optional(),
});

type TeacherRouteVariables = {
  teacherUserId: string;
};

export const teacherRoutes = new Hono<{ Variables: TeacherRouteVariables }>();

teacherRoutes.use("*", async (c, next) => {
  const user = await getAuthenticatedAppUser(c);

  if (!user) {
    return c.json({ message: "No autenticado" }, 401);
  }

  if (!user.profile?.isActive || user.profile.role !== "docente") {
    return c.json({ message: "Solo docentes pueden acceder a este recurso" }, 403);
  }

  c.set("teacherUserId", user.id);
  await next();
});

teacherRoutes.get("/academic-spaces", async (c) => {
  const teacherUserId = c.get("teacherUserId");
  const rows = await query<TeacherSpaceRow>(
    `
      SELECT
        s.id::text,
        s.code,
        s.name,
        p.id::text AS program_id,
        p.name AS program_name,
        COUNT(ass.student_user_id)::text AS students_count
      FROM academic_space_teachers ast
      JOIN academic_spaces s ON s.id = ast.academic_space_id
      JOIN academic_programs p ON p.id = s.program_id
      LEFT JOIN academic_space_students ass ON ass.academic_space_id = s.id
      WHERE ast.teacher_user_id = $1 AND s.is_active = TRUE
      GROUP BY s.id, s.code, s.name, p.id, p.name
      ORDER BY p.name, s.name
    `,
    [teacherUserId],
  );

  return c.json({
    academicSpaces: rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      programId: row.program_id,
      programName: row.program_name,
      studentsCount: Number(row.students_count),
    })),
  });
});

teacherRoutes.get("/live-talks", async (c) => {
  const teacherUserId = c.get("teacherUserId");
  const rows = await query<LiveTalkRow>(
    `
      SELECT
        lt.id::text,
        lt.academic_space_id::text,
        s.name AS academic_space_name,
        lt.title,
        lt.general_topic,
        lt.status,
        lt.opens_at::text,
        lt.closes_at::text,
        lt.created_at::text,
        COALESCE(
          ARRAY_AGG(ltt.name ORDER BY ltt.sort_order) FILTER (WHERE ltt.id IS NOT NULL),
          ARRAY[]::text[]
        ) AS topics
      FROM live_talks lt
      JOIN academic_spaces s ON s.id = lt.academic_space_id
      JOIN academic_space_teachers ast ON ast.academic_space_id = s.id
      LEFT JOIN live_talk_topics ltt ON ltt.live_talk_id = lt.id
      WHERE ast.teacher_user_id = $1
      GROUP BY lt.id, s.name
      ORDER BY lt.created_at DESC
    `,
    [teacherUserId],
  );

  return c.json({ liveTalks: rows.map(formatLiveTalk) });
});

teacherRoutes.get("/live-talks/:id/results", async (c) => {
  const teacherUserId = c.get("teacherUserId");
  const id = c.req.param("id");

  const canManage = await canTeacherManageLiveTalk(teacherUserId, id);
  if (!canManage) {
    return c.json({ message: "El docente no puede consultar este live talk" }, 403);
  }

  const rows = await query<TeacherAttemptResultRow>(
    `
      SELECT
        ea.id::text,
        ea.student_user_id,
        u.name AS student_name,
        u.email AS student_email,
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
      JOIN "user" u ON u.id = ea.student_user_id
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
      WHERE ea.live_talk_id = $1
      ORDER BY ea.started_at DESC
    `,
    [id],
  );

  return c.json({
    results: rows.map((row) => ({
      id: row.id,
      studentUserId: row.student_user_id,
      studentName: row.student_name,
      studentEmail: row.student_email,
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
    })),
  });
});

teacherRoutes.get("/attempts/:id", async (c) => {
  const teacherUserId = c.get("teacherUserId");
  const id = c.req.param("id");

  const attemptRows = await query<TeacherAttemptDetailRow>(
    `
      SELECT
        ea.id::text,
        ea.student_user_id,
        u.name AS student_name,
        u.email AS student_email,
        lt.id::text AS live_talk_id,
        lt.title AS live_talk_title,
        lt.general_topic,
        s.name AS academic_space_name,
        p.name AS program_name,
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
      JOIN "user" u ON u.id = ea.student_user_id
      JOIN live_talks lt ON lt.id = ea.live_talk_id
      JOIN academic_spaces s ON s.id = lt.academic_space_id
      JOIN academic_programs p ON p.id = s.program_id
      JOIN academic_space_teachers ast ON ast.academic_space_id = s.id
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
        AND ast.teacher_user_id = $2
    `,
    [id, teacherUserId],
  );

  const attempt = attemptRows[0];

  if (!attempt) {
    return c.json({ message: "Intento no encontrado para este docente" }, 404);
  }

  const rubricRows = attempt.evaluation_id
    ? await query<TeacherRubricItemRow>(
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

  const transcriptRows = await query<TeacherTranscriptTurnRow>(
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
      id: attempt.id,
      studentUserId: attempt.student_user_id,
      studentName: attempt.student_name,
      studentEmail: attempt.student_email,
      liveTalkId: attempt.live_talk_id,
      liveTalkTitle: attempt.live_talk_title,
      generalTopic: attempt.general_topic,
      academicSpaceName: attempt.academic_space_name,
      programName: attempt.program_name,
      status: attempt.status,
      startedAt: attempt.started_at,
      completedAt: attempt.completed_at,
      finalScore: attempt.final_score === null ? null : Number(attempt.final_score),
      evaluationId: attempt.evaluation_id,
      evaluationStatus: attempt.evaluation_status,
      evaluationError: attempt.evaluation_error,
      rubricVersion: attempt.rubric_version,
      evaluatorModel: attempt.evaluator_model,
      evaluatorModelVersion: attempt.evaluator_model_version,
      teacherReviewed: attempt.teacher_reviewed ?? false,
      teacherOverrideGrade: attempt.teacher_override_grade === null
        ? null
        : Number(attempt.teacher_override_grade),
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

teacherRoutes.patch(
  "/attempts/:id/review",
  zValidator(
    "json",
    z.object({
      teacherReviewed: z.boolean().default(true),
      teacherOverrideGrade: z.number().min(0).max(5).nullable().optional(),
      teacherOverrideReason: z.string().trim().max(1000).nullable().optional(),
    }),
  ),
  async (c) => {
    const teacherUserId = c.get("teacherUserId");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const overrideGrade = body.teacherOverrideGrade ?? null;
    const overrideReason = body.teacherOverrideReason?.trim() || null;

    if (overrideGrade !== null && !overrideReason) {
      return c.json({ message: "El ajuste de nota requiere una justificación." }, 400);
    }

    const contextRows = await query<TeacherReviewContextRow>(
      `
        SELECT
          ea.id::text AS attempt_id,
          ev.id::text AS evaluation_id,
          ev.rubric_version,
          ea.student_user_id,
          lt.academic_space_id::text,
          lt.id::text AS live_talk_id,
          COALESCE(gh.calculated_grade, ea.final_score)::text AS calculated_grade,
          COALESCE(gh.evaluator_model, ev.evaluator_model) AS evaluator_model,
          COALESCE(gh.evaluator_model_version, ev.evaluator_model_version) AS evaluator_model_version
        FROM evaluation_attempts ea
        JOIN live_talks lt ON lt.id = ea.live_talk_id
        JOIN academic_spaces s ON s.id = lt.academic_space_id
        JOIN academic_space_teachers ast ON ast.academic_space_id = s.id
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
        WHERE ea.id = $1
          AND ast.teacher_user_id = $2
      `,
      [id, teacherUserId],
    );

    const context = contextRows[0];

    if (!context) {
      return c.json({ message: "Intento no encontrado para este docente" }, 404);
    }

    if (!context.evaluation_id || context.calculated_grade === null) {
      return c.json({ message: "El intento aún no tiene una evaluación calculada." }, 409);
    }

    await query(
      `
        INSERT INTO grade_history (
          attempt_id,
          evaluation_id,
          rubric_version,
          student_user_id,
          academic_space_id,
          live_talk_id,
          score,
          calculated_grade,
          evaluator_model,
          evaluator_model_version,
          teacher_reviewed,
          teacher_override_grade,
          teacher_override_reason
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12)
      `,
      [
        context.attempt_id,
        context.evaluation_id,
        context.rubric_version,
        context.student_user_id,
        context.academic_space_id,
        context.live_talk_id,
        Number(context.calculated_grade),
        context.evaluator_model,
        context.evaluator_model_version,
        body.teacherReviewed,
        overrideGrade,
        overrideReason,
      ],
    );

    return c.json({
      ok: true,
      teacherReviewed: body.teacherReviewed,
      teacherOverrideGrade: overrideGrade,
      teacherOverrideReason: overrideReason,
    });
  },
);

teacherRoutes.post(
  "/live-talks",
  zValidator("json", liveTalkSchema),
  async (c) => {
    const teacherUserId = c.get("teacherUserId");
    const body = c.req.valid("json");

    const canManage = await canTeacherManageSpace(teacherUserId, body.academicSpaceId);
    if (!canManage) {
      return c.json({ message: "El docente no está asignado a este espacio académico" }, 403);
    }

    const rows = await query<{ id: string }>(
      `
        INSERT INTO live_talks (
          academic_space_id,
          created_by_teacher_user_id,
          title,
          general_topic,
          opens_at,
          closes_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id::text
      `,
      [
        body.academicSpaceId,
        teacherUserId,
        body.title,
        body.generalTopic,
        body.opensAt ?? null,
        body.closesAt ?? null,
      ],
    );

    await replaceTopics(rows[0].id, body.topics);

    return c.json({ id: rows[0].id }, 201);
  },
);

teacherRoutes.patch(
  "/live-talks/:id",
  zValidator("json", liveTalkSchema),
  async (c) => {
    const teacherUserId = c.get("teacherUserId");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const canManage = await canTeacherManageLiveTalk(teacherUserId, id);
    if (!canManage) {
      return c.json({ message: "El docente no puede modificar este live talk" }, 403);
    }

    const currentRows = await query<{ status: string }>(
      `SELECT status FROM live_talks WHERE id = $1`,
      [id],
    );

    if (currentRows[0]?.status !== "draft") {
      return c.json({ message: "Solo se pueden editar live talks en borrador" }, 409);
    }

    await query(
      `
        UPDATE live_talks
        SET
          academic_space_id = $2,
          title = $3,
          general_topic = $4,
          opens_at = $5,
          closes_at = $6,
          updated_at = now()
        WHERE id = $1
      `,
      [
        id,
        body.academicSpaceId,
        body.title,
        body.generalTopic,
        body.opensAt ?? null,
        body.closesAt ?? null,
      ],
    );

    await replaceTopics(id, body.topics);

    return c.json({ ok: true });
  },
);

teacherRoutes.patch("/live-talks/:id/status", zValidator(
  "json",
  z.object({ status: z.enum(["draft", "active", "closed"]) }),
), async (c) => {
  const teacherUserId = c.get("teacherUserId");
  const id = c.req.param("id");
  const body = c.req.valid("json");

  const canManage = await canTeacherManageLiveTalk(teacherUserId, id);
  if (!canManage) {
    return c.json({ message: "El docente no puede modificar este live talk" }, 403);
  }

  await query(
    `
      UPDATE live_talks
      SET status = $2, updated_at = now()
      WHERE id = $1
    `,
    [id, body.status],
  );

  return c.json({ ok: true });
});

teacherRoutes.delete("/live-talks/:id", async (c) => {
  const teacherUserId = c.get("teacherUserId");
  const id = c.req.param("id");

  const canManage = await canTeacherManageLiveTalk(teacherUserId, id);
  if (!canManage) {
    return c.json({ message: "El docente no puede eliminar este live talk" }, 403);
  }

  const currentRows = await query<{ status: string }>(
    `SELECT status FROM live_talks WHERE id = $1`,
    [id],
  );

  if (currentRows[0]?.status !== "draft") {
    return c.json({ message: "Solo se pueden eliminar live talks en borrador" }, 409);
  }

  await query(`DELETE FROM live_talks WHERE id = $1`, [id]);

  return c.json({ ok: true });
});

async function canTeacherManageSpace(teacherUserId: string, academicSpaceId: string) {
  const rows = await query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM academic_space_teachers
        WHERE teacher_user_id = $1 AND academic_space_id = $2
      ) AS exists
    `,
    [teacherUserId, academicSpaceId],
  );

  return rows[0]?.exists ?? false;
}

async function canTeacherManageLiveTalk(teacherUserId: string, liveTalkId: string) {
  const rows = await query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM live_talks lt
        JOIN academic_space_teachers ast ON ast.academic_space_id = lt.academic_space_id
        WHERE ast.teacher_user_id = $1 AND lt.id = $2
      ) AS exists
    `,
    [teacherUserId, liveTalkId],
  );

  return rows[0]?.exists ?? false;
}

async function replaceTopics(liveTalkId: string, topics: string[]) {
  await query(`DELETE FROM live_talk_topics WHERE live_talk_id = $1`, [liveTalkId]);

  for (const [index, topic] of topics.entries()) {
    await query(
      `
        INSERT INTO live_talk_topics (live_talk_id, name, sort_order)
        VALUES ($1, $2, $3)
      `,
      [liveTalkId, topic, index],
    );
  }
}

function formatLiveTalk(row: LiveTalkRow) {
  return {
    id: row.id,
    academicSpaceId: row.academic_space_id,
    academicSpaceName: row.academic_space_name,
    title: row.title,
    generalTopic: row.general_topic,
    status: row.status,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    createdAt: row.created_at,
    topics: row.topics ?? [],
  };
}
