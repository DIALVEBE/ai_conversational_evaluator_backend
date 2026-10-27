import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as z from "@zod/zod";

import { query } from "@/infrastructure/database/postgres.ts";
import { getAuthenticatedAppUser } from "@/interfaces/http/session.ts";
import {
  EvaluationCannotRunError,
  evaluateAttemptTranscript,
  normalizeRealtimeMessages,
  storeAttemptTranscript,
} from "@/services/evaluation-service.ts";

type StudentLiveTalkRow = {
  id: string;
  academic_space_id: string;
  academic_space_name: string;
  program_name: string;
  title: string;
  general_topic: string;
  status: "active";
  opens_at: string | null;
  closes_at: string | null;
  topics: string[] | null;
};

type StudentAttemptRow = {
  id: string;
  live_talk_id: string;
  live_talk_title: string;
  academic_space_name: string;
  program_name: string;
  status: "in_progress" | "completed" | "cancelled";
  started_at: string;
  completed_at: string | null;
  final_score: string | null;
  feedback_summary: string | null;
  evaluation_status: "completed" | "failed" | null;
  evaluation_error: string | null;
};

type StudentAttemptDetailRow = StudentAttemptRow & {
  general_topic: string;
  evaluation_id: string | null;
  rubric_version: string | null;
  evaluator_model: string | null;
  evaluator_model_version: string | null;
  teacher_reviewed: boolean | null;
  teacher_override_grade: string | null;
  teacher_override_reason: string | null;
  strengths: string | null;
  improvement_opportunities: string | null;
  recommendations: string | null;
};

type StudentRubricItemRow = {
  id: string;
  topic: string | null;
  score: string;
  max_score: string;
  performance_level: string;
  evidence_turns: Array<{ turn_id: number; fragment: string }> | null;
  justification: string;
};

type StudentTranscriptTurnRow = {
  turn_id: number;
  speaker: "student" | "evaluator";
  text: string;
  occurred_at: string | null;
  source_message_id: string | null;
};

type StudentRouteVariables = {
  studentUserId: string;
};

export const studentRoutes = new Hono<{ Variables: StudentRouteVariables }>();

studentRoutes.use("*", async (c, next) => {
  const user = await getAuthenticatedAppUser(c);

  if (!user) {
    return c.json({ message: "No autenticado" }, 401);
  }

  if (!user.profile?.isActive || user.profile.role !== "estudiante") {
    return c.json({ message: "Solo estudiantes pueden acceder a este recurso" }, 403);
  }

  c.set("studentUserId", user.id);
  await next();
});

studentRoutes.get("/live-talks", async (c) => {
  const studentUserId = c.get("studentUserId");
  const rows = await query<StudentLiveTalkRow>(
    `
      SELECT
        lt.id::text,
        lt.academic_space_id::text,
        s.name AS academic_space_name,
        p.name AS program_name,
        lt.title,
        lt.general_topic,
        lt.status,
        lt.opens_at::text,
        lt.closes_at::text,
        COALESCE(
          ARRAY_AGG(ltt.name ORDER BY ltt.sort_order) FILTER (WHERE ltt.id IS NOT NULL),
          ARRAY[]::text[]
        ) AS topics
      FROM live_talks lt
      JOIN academic_spaces s ON s.id = lt.academic_space_id
      JOIN academic_programs p ON p.id = s.program_id
      JOIN academic_space_students ass ON ass.academic_space_id = s.id
      JOIN program_students ps ON ps.program_id = p.id AND ps.student_user_id = ass.student_user_id
      LEFT JOIN live_talk_topics ltt ON ltt.live_talk_id = lt.id
      WHERE
        ass.student_user_id = $1
        AND lt.status = 'active'
        AND s.is_active = TRUE
        AND p.is_active = TRUE
        AND (lt.opens_at IS NULL OR lt.opens_at <= now())
        AND (lt.closes_at IS NULL OR lt.closes_at >= now())
      GROUP BY lt.id, s.name, p.name
      ORDER BY lt.created_at DESC
    `,
    [studentUserId],
  );

  return c.json({
    liveTalks: rows.map((row) => ({
      id: row.id,
      academicSpaceId: row.academic_space_id,
      academicSpaceName: row.academic_space_name,
      programName: row.program_name,
      title: row.title,
      generalTopic: row.general_topic,
      status: row.status,
      opensAt: row.opens_at,
      closesAt: row.closes_at,
      topics: row.topics ?? [],
    })),
  });
});

studentRoutes.get("/attempts", async (c) => {
  const studentUserId = c.get("studentUserId");
  const rows = await query<StudentAttemptRow>(
    `
      SELECT
        ea.id::text,
        lt.id::text AS live_talk_id,
        lt.title AS live_talk_title,
        s.name AS academic_space_name,
        p.name AS program_name,
        ea.status,
        ea.started_at::text,
        ea.completed_at::text,
        ea.final_score::text,
        ev.status AS evaluation_status,
        ev.error_message AS evaluation_error,
        ef.summary AS feedback_summary
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
      LEFT JOIN evaluation_feedback ef ON ef.evaluation_id = ev.id
      WHERE ea.student_user_id = $1
      ORDER BY ea.started_at DESC
    `,
    [studentUserId],
  );

  return c.json({
    attempts: rows.map((row) => ({
      id: row.id,
      liveTalkId: row.live_talk_id,
      liveTalkTitle: row.live_talk_title,
      academicSpaceName: row.academic_space_name,
      programName: row.program_name,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      finalScore: row.final_score === null ? null : Number(row.final_score),
      evaluationStatus: row.evaluation_status,
      evaluationError: row.evaluation_error,
      feedbackSummary: row.feedback_summary,
    })),
  });
});

studentRoutes.get("/attempts/:id", async (c) => {
  const studentUserId = c.get("studentUserId");
  const id = c.req.param("id");

  const attemptRows = await query<StudentAttemptDetailRow>(
    `
      SELECT
        ea.id::text,
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
      LEFT JOIN evaluation_feedback ef ON ef.evaluation_id = ev.id
      LEFT JOIN LATERAL (
        SELECT *
        FROM grade_history current_grade
        WHERE current_grade.evaluation_id = ev.id
        ORDER BY current_grade.recorded_at DESC
        LIMIT 1
      ) gh ON TRUE
      WHERE ea.id = $1
        AND ea.student_user_id = $2
    `,
    [id, studentUserId],
  );

  const attempt = attemptRows[0];

  if (!attempt) {
    return c.json({ message: "Intento no encontrado" }, 404);
  }

  const rubricRows = attempt.evaluation_id
    ? await query<StudentRubricItemRow>(
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

  const transcriptRows = await query<StudentTranscriptTurnRow>(
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

studentRoutes.patch(
  "/attempts/:id/finish",
  zValidator(
    "json",
    z.object({
      status: z.enum(["completed", "cancelled"]).default("completed"),
      messages: z.array(z.object({
        id: z.string().optional(),
        role: z.enum(["user", "assistant"]),
        timestamp: z.number().optional(),
        parts: z.array(z.object({
          type: z.string(),
          content: z.string().optional(),
          transcript: z.string().optional(),
        })),
        interrupted: z.boolean().optional(),
        audioId: z.string().optional(),
        durationMs: z.number().optional(),
      })).default([]),
      realtimeEvents: z.array(z.object({
        eventType: z.string(),
        providerEventId: z.string().optional(),
        sourceMessageId: z.string().optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
      })).default([]),
    }),
  ),
  async (c) => {
    const studentUserId = c.get("studentUserId");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const turns = normalizeRealtimeMessages(body.messages);
    const availableRows = await query<{ id: string }>(
      `
        SELECT id::text
        FROM evaluation_attempts
        WHERE id = $1
          AND student_user_id = $2
          AND status = 'in_progress'
      `,
      [id, studentUserId],
    );

    if (!availableRows[0]) {
      return c.json({ message: "Intento no disponible para finalizar" }, 404);
    }

    if (body.status === "completed") {
      await storeAttemptTranscript(id, turns, body.realtimeEvents);
    }

    const updatedRows = await query<{ id: string }>(
      `
        UPDATE evaluation_attempts
        SET
          status = $3,
          completed_at = now(),
          updated_at = now()
        WHERE id = $1
          AND student_user_id = $2
          AND status = 'in_progress'
        RETURNING id::text
      `,
      [id, studentUserId, body.status],
    );

    if (!updatedRows[0]) {
      return c.json({ message: "Intento no disponible para finalizar" }, 404);
    }

    if (body.status === "cancelled") {
      return c.json({ ok: true, evaluationStatus: "skipped" });
    }

    try {
      const evaluation = await evaluateAttemptTranscript(id);

      return c.json({
        ok: true,
        evaluationStatus: "completed",
        evaluationId: evaluation.evaluationId,
        grade: evaluation.grade,
      });
    } catch (error) {
      console.error(error);

      return c.json({
        ok: true,
        evaluationStatus: "failed",
        message: error instanceof EvaluationCannotRunError
          ? error.message
          : "El intento fue cerrado, pero la evaluación automática no pudo completarse.",
      }, 202);
    }
  },
);
