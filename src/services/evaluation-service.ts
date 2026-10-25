import { OpenAI } from "openai";

import { pool, query } from "@/infrastructure/database/postgres.ts";

const EVALUATOR_MODEL = Deno.env.get("OPENAI_EVALUATOR_MODEL") ?? "gpt-4o-mini";
const EVALUATOR_MODEL_VERSION = Deno.env.get("OPENAI_EVALUATOR_MODEL_VERSION") ?? EVALUATOR_MODEL;
const RUBRIC_VERSION = "academic-topics-v1";
const GRADE_SCALE_MAX = 5;
const TOPIC_MAX_SCORE = 4;

type RealtimeMessagePartInput = {
  type: string;
  content?: string;
  transcript?: string;
};

export type RealtimeMessageInput = {
  id?: string;
  role: "user" | "assistant";
  timestamp?: number;
  parts: RealtimeMessagePartInput[];
  interrupted?: boolean;
  audioId?: string;
  durationMs?: number;
};

export type RealtimeTraceEventInput = {
  eventType: string;
  providerEventId?: string;
  sourceMessageId?: string;
  payload?: Record<string, unknown>;
};

export type NormalizedTranscriptTurn = {
  turnId: number;
  speaker: "student" | "evaluator";
  text: string;
  occurredAt: string | null;
  sourceMessageId: string | null;
  sourceEventType: string;
  rawMetadata: Record<string, unknown>;
};

type AttemptEvaluationContext = {
  attempt_id: string;
  student_user_id: string;
  live_talk_id: string;
  academic_space_id: string;
  general_topic: string;
};

type TopicRow = {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
};

type StoredTurnRow = {
  turn_id: number;
  speaker: "student" | "evaluator";
  text: string;
};

type ModelRubricItem = {
  topic?: unknown;
  score?: unknown;
  performance_level?: unknown;
  evidence?: unknown;
  justification?: unknown;
};

type ModelEvaluationOutput = {
  rubric_items?: unknown;
};

type NormalizedRubricItem = {
  topicId: string;
  topic: string;
  score: number;
  maxScore: number;
  performanceLevel: string;
  evidence: Array<{ turn_id: number; fragment: string }>;
  justification: string;
};

type ExistingEvaluationRow = {
  evaluation_id: string;
  calculated_grade: string | null;
  final_score: string | null;
};

const evaluatorClient = new OpenAI({
  apiKey: Deno.env.get("OPENAI_API_KEY"),
});

export class EvaluationCannotRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationCannotRunError";
  }
}

export function normalizeRealtimeMessages(
  messages: RealtimeMessageInput[],
): NormalizedTranscriptTurn[] {
  const turns: Array<NormalizedTranscriptTurn | null> = messages
    .map((message) => {
      const text = message.parts
        .map((part) => {
          if (part.type === "audio") return part.transcript ?? "";
          if (part.type === "text") return part.content ?? "";
          return "";
        })
        .join("\n")
        .trim();

      if (!text) return null;

      const turn: NormalizedTranscriptTurn = {
        turnId: 0,
        speaker: message.role === "user" ? "student" : "evaluator",
        text,
        occurredAt: message.timestamp ? new Date(message.timestamp).toISOString() : null,
        sourceMessageId: message.id ?? null,
        sourceEventType: "message_complete",
        rawMetadata: {
          realtimeMessageId: message.id ?? null,
          role: message.role,
          interrupted: message.interrupted ?? false,
          audioId: message.audioId ?? null,
          durationMs: message.durationMs ?? null,
        },
      };

      return turn;
    });

  return turns
    .filter((turn): turn is NormalizedTranscriptTurn => turn !== null)
    .map((turn, index) => ({ ...turn, turnId: index + 1 }));
}

export async function storeAttemptTranscript(
  attemptId: string,
  turns: NormalizedTranscriptTurn[],
  traceEvents: RealtimeTraceEventInput[],
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM evaluation_realtime_events WHERE attempt_id = $1", [attemptId]);
    await client.query("DELETE FROM evaluation_transcript_turns WHERE attempt_id = $1", [attemptId]);

    for (const [index, turn] of turns.entries()) {
      await client.query(
        `
          INSERT INTO evaluation_transcript_turns (
            attempt_id,
            turn_id,
            speaker,
            text,
            occurred_at,
            source_message_id,
            source_event_type,
            raw_metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        `,
        [
          attemptId,
          index + 1,
          turn.speaker,
          turn.text,
          turn.occurredAt,
          turn.sourceMessageId,
          turn.sourceEventType,
          JSON.stringify(turn.rawMetadata),
        ],
      );
    }

    const events: RealtimeTraceEventInput[] = traceEvents.length > 0
      ? traceEvents
      : turns.map((turn) => ({
        eventType: "message_complete",
        sourceMessageId: turn.sourceMessageId ?? undefined,
        payload: {
          turnId: turn.turnId,
          speaker: turn.speaker,
          text: turn.text,
          metadata: turn.rawMetadata,
        },
      }));

    for (const [index, event] of events.entries()) {
      await client.query(
        `
          INSERT INTO evaluation_realtime_events (
            attempt_id,
            event_order,
            event_type,
            provider_event_id,
            source_message_id,
            payload
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        `,
        [
          attemptId,
          index + 1,
          event.eventType,
          event.providerEventId ?? null,
          event.sourceMessageId ?? null,
          JSON.stringify(event.payload ?? {}),
        ],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function evaluateAttemptTranscript(attemptId: string): Promise<{
  evaluationId: string;
  grade: number;
}> {
  const [context] = await query<AttemptEvaluationContext>(
    `
      SELECT
        ea.id::text AS attempt_id,
        ea.student_user_id,
        lt.id::text AS live_talk_id,
        lt.academic_space_id::text,
        lt.general_topic
      FROM evaluation_attempts ea
      JOIN live_talks lt ON lt.id = ea.live_talk_id
      WHERE ea.id = $1
    `,
    [attemptId],
  );

  if (!context) {
    throw new Error("Attempt not found");
  }

  const existingCompletedRows = await query<ExistingEvaluationRow>(
    `
      SELECT
        ev.id::text AS evaluation_id,
        gh.calculated_grade::text,
        ea.final_score::text
      FROM evaluations ev
      JOIN evaluation_attempts ea ON ea.id = ev.attempt_id
      LEFT JOIN LATERAL (
        SELECT *
        FROM grade_history current_grade
        WHERE current_grade.evaluation_id = ev.id
        ORDER BY current_grade.recorded_at DESC
        LIMIT 1
      ) gh ON TRUE
      WHERE ev.attempt_id = $1
        AND ev.status = 'completed'
      ORDER BY ev.created_at DESC
      LIMIT 1
    `,
    [attemptId],
  );

  const existingCompleted = existingCompletedRows[0];
  if (existingCompleted) {
    const grade = existingCompleted.calculated_grade ?? existingCompleted.final_score;

    if (grade !== null) {
      return {
        evaluationId: existingCompleted.evaluation_id,
        grade: Number(grade),
      };
    }

    throw new EvaluationCannotRunError("El intento ya tiene una evaluación completada sin nota calculada.");
  }

  const topics = await query<TopicRow>(
    `
      SELECT id::text, name, description, sort_order
      FROM live_talk_topics
      WHERE live_talk_id = $1
      ORDER BY sort_order, name
    `,
    [context.live_talk_id],
  );

  const turns = await query<StoredTurnRow>(
    `
      SELECT turn_id, speaker, text
      FROM evaluation_transcript_turns
      WHERE attempt_id = $1
      ORDER BY turn_id
    `,
    [attemptId],
  );

  const transcriptHash = await hashTranscript(turns);

  if (turns.length === 0) {
    await recordFailedEvaluation(context, transcriptHash, "No se puede evaluar un intento sin transcript normalizado.");
    throw new EvaluationCannotRunError("No se puede evaluar un intento sin transcript normalizado.");
  }

  if (topics.length === 0) {
    await recordFailedEvaluation(context, transcriptHash, "No se puede evaluar un live talk sin temáticas específicas.");
    throw new EvaluationCannotRunError("No se puede evaluar un live talk sin temáticas específicas.");
  }

  let modelItems: ModelRubricItem[];

  try {
    modelItems = await requestRubricItemsFromModel(context.general_topic, topics, turns);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "No fue posible ejecutar el modelo evaluador.";
    await recordFailedEvaluation(context, transcriptHash, message);
    throw new EvaluationCannotRunError("No fue posible ejecutar la evaluación automática.");
  }

  const rubricItems = normalizeRubricItems(topics, turns, modelItems);
  const calculatedGrade = calculateGrade(rubricItems, GRADE_SCALE_MAX);
  const feedback = buildFeedbackFromRubric(rubricItems);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const evaluationRows = await client.query<{ id: string }>(
      `
        INSERT INTO evaluations (
          attempt_id,
          rubric_version,
          evaluator_model,
          evaluator_model_version,
          grade_scale_max,
          transcript_hash,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'completed')
        RETURNING id::text
      `,
      [
        attemptId,
        RUBRIC_VERSION,
        EVALUATOR_MODEL,
        EVALUATOR_MODEL_VERSION,
        GRADE_SCALE_MAX,
        transcriptHash,
      ],
    );
    const evaluationId = evaluationRows.rows[0].id;

    await client.query("DELETE FROM evaluation_feedback WHERE attempt_id = $1", [attemptId]);
    await client.query("DELETE FROM evaluation_rubric_items WHERE attempt_id = $1", [attemptId]);

    for (const item of rubricItems) {
      await client.query(
        `
          INSERT INTO evaluation_rubric_items (
            evaluation_id,
            attempt_id,
            live_talk_topic_id,
            topic,
            criterion,
            performance_level,
            score,
            max_score,
            evidence,
            evidence_turns,
            justification
          )
          VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9::jsonb, $10)
        `,
        [
          evaluationId,
          attemptId,
          item.topicId,
          item.topic,
          item.performanceLevel,
          item.score,
          item.maxScore,
          item.evidence.map((evidence) => `T${evidence.turn_id}: ${evidence.fragment}`).join("\n"),
          JSON.stringify(item.evidence),
          item.justification,
        ],
      );
    }

    await client.query(
      `
        INSERT INTO evaluation_feedback (
          attempt_id,
          evaluation_id,
          summary,
          strengths,
          improvement_opportunities,
          recommendations
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        attemptId,
        evaluationId,
        feedback.summary,
        feedback.strengths,
        feedback.improvementOpportunities,
        feedback.recommendations,
      ],
    );

    await client.query(
      `
        UPDATE evaluation_attempts
        SET final_score = $2, updated_at = now()
        WHERE id = $1
      `,
      [attemptId, calculatedGrade],
    );

    await client.query(
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, FALSE, NULL, NULL)
      `,
      [
        attemptId,
        evaluationId,
        RUBRIC_VERSION,
        context.student_user_id,
        context.academic_space_id,
        context.live_talk_id,
        calculatedGrade,
        EVALUATOR_MODEL,
        EVALUATOR_MODEL_VERSION,
      ],
    );

    await client.query("COMMIT");
    return { evaluationId, grade: calculatedGrade };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function recordFailedEvaluation(
  context: AttemptEvaluationContext,
  transcriptHash: string,
  errorMessage: string,
): Promise<void> {
  await query(
    `
      INSERT INTO evaluations (
        attempt_id,
        rubric_version,
        evaluator_model,
        evaluator_model_version,
        grade_scale_max,
        transcript_hash,
        status,
        error_message
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'failed', $7)
    `,
    [
      context.attempt_id,
      RUBRIC_VERSION,
      EVALUATOR_MODEL,
      EVALUATOR_MODEL_VERSION,
      GRADE_SCALE_MAX,
      transcriptHash,
      errorMessage,
    ],
  );
}

async function requestRubricItemsFromModel(
  generalTopic: string,
  topics: TopicRow[],
  turns: StoredTurnRow[],
): Promise<ModelRubricItem[]> {
  const response = await evaluatorClient.chat.completions.create({
    model: EVALUATOR_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Eres un evaluador académico. Evalúa exclusivamente evidencia académica del transcript. No uses pronunciación, acento, velocidad, pausas, muletillas, fluidez oral, estilo verbal ni resúmenes como criterio. Devuelve solo JSON válido.",
      },
      {
        role: "user",
        content: JSON.stringify({
          task:
            "Analiza el transcript normalizado contra cada specific_topic. Para cada topic devuelve score 0-4, performance_level, evidence y justification. La nota final NO debe ser calculada por ti.",
          scale: {
            "0": "sin evidencia o comprensión incorrecta",
            "1": "comprensión inicial con errores importantes",
            "2": "comprende la idea principal",
            "3": "comprende y puede aplicarla o relacionarla",
            "4": "comprensión sólida, aplicación y justificación",
          },
          general_topic: generalTopic,
          specific_topics: topics.map((topic) => ({
            id: topic.id,
            name: topic.name,
            description: topic.description,
          })),
          transcript: turns.map((turn) => ({
            turn_id: turn.turn_id,
            speaker: turn.speaker,
            text: turn.text,
          })),
          required_json_shape: {
            rubric_items: [
              {
                topic: "exact specific topic name",
                score: "integer 0..4",
                performance_level: "short Spanish label",
                evidence: [
                  {
                    turn_id: "number from transcript, preferably student turns",
                    fragment: "short exact textual fragment from that turn",
                  },
                ],
                justification: "Spanish academic justification based only on transcript evidence",
              },
            ],
          },
        }),
      },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "{}";
  const parsed = parseJsonObject(content) as ModelEvaluationOutput;

  return Array.isArray(parsed.rubric_items) ? parsed.rubric_items as ModelRubricItem[] : [];
}

function normalizeRubricItems(
  topics: TopicRow[],
  turns: StoredTurnRow[],
  modelItems: ModelRubricItem[],
): NormalizedRubricItem[] {
  const itemsByTopic = new Map(
    modelItems
      .map((item) => [String(item.topic ?? "").trim().toLocaleLowerCase(), item] as const)
      .filter(([topic]) => topic.length > 0),
  );

  return topics.map((topic) => {
    const modelItem = itemsByTopic.get(topic.name.trim().toLocaleLowerCase());
    const score = clampScore(modelItem?.score);
    const evidence = normalizeEvidence(modelItem?.evidence, turns);

    return {
      topicId: topic.id,
      topic: topic.name,
      score,
      maxScore: TOPIC_MAX_SCORE,
      performanceLevel: normalizePerformanceLevel(score, modelItem?.performance_level),
      evidence,
      justification: String(modelItem?.justification ?? "").trim() ||
        (score === 0
          ? "No se encontró evidencia académica suficiente en el transcript para este tema."
          : "La calificación se sustenta en los fragmentos citados del transcript normalizado."),
    };
  });
}

function normalizeEvidence(
  rawEvidence: unknown,
  turns: StoredTurnRow[],
): Array<{ turn_id: number; fragment: string }> {
  if (!Array.isArray(rawEvidence)) return [];

  const turnsById = new Map(turns.map((turn) => [turn.turn_id, turn]));

  return rawEvidence
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const turnId = Number(record.turn_id);
      const fragment = String(record.fragment ?? "").trim();
      const turn = turnsById.get(turnId);

      if (!Number.isInteger(turnId) || !turn || !fragment) return null;

      const evidenceFragment = turn.text.toLocaleLowerCase().includes(fragment.toLocaleLowerCase())
        ? fragment
        : turn.text;

      return {
        turn_id: turnId,
        fragment: evidenceFragment.length > 500 ? evidenceFragment.slice(0, 500) : evidenceFragment,
      };
    })
    .filter((item): item is { turn_id: number; fragment: string } => item !== null);
}

function clampScore(rawScore: unknown): number {
  const score = Number(rawScore);
  if (!Number.isFinite(score)) return 0;
  return Math.min(TOPIC_MAX_SCORE, Math.max(0, Math.round(score)));
}

function normalizePerformanceLevel(score: number, rawLevel: unknown): string {
  const level = String(rawLevel ?? "").trim();
  if (level) return level;

  if (score === 0) return "Sin evidencia o comprensión incorrecta";
  if (score === 1) return "Comprensión inicial con errores importantes";
  if (score === 2) return "Comprende la idea principal";
  if (score === 3) return "Comprende y puede aplicarla o relacionarla";
  return "Comprensión sólida, aplicación y justificación";
}

function calculateGrade(items: NormalizedRubricItem[], gradeScaleMax: number): number {
  const totalScore = items.reduce((sum, item) => sum + item.score, 0);
  const totalMaxScore = items.reduce((sum, item) => sum + item.maxScore, 0);

  if (totalMaxScore === 0) return 0;

  return Math.round((totalScore / totalMaxScore) * gradeScaleMax * 100) / 100;
}

function buildFeedbackFromRubric(items: NormalizedRubricItem[]): {
  summary: string;
  strengths: string;
  improvementOpportunities: string;
  recommendations: string;
} {
  const strengths = items
    .filter((item) => item.score >= 3)
    .map((item) => `${item.topic}: ${item.performanceLevel}.`);
  const improvements = items
    .filter((item) => item.score <= 2)
    .map((item) => `${item.topic}: ${item.performanceLevel}. ${item.justification}`);

  return {
    summary: `Evaluación calculada a partir de ${items.length} ítems de rúbrica y evidencia citada del transcript normalizado.`,
    strengths: strengths.length > 0
      ? strengths.join("\n")
      : "No se identificaron fortalezas suficientes con la evidencia disponible.",
    improvementOpportunities: improvements.length > 0
      ? improvements.join("\n")
      : "No se identificaron aspectos criticos por fortalecer en los temas evaluados.",
    recommendations: items
      .filter((item) => item.score < TOPIC_MAX_SCORE)
      .map((item) => `Reforzar ${item.topic} con explicaciones, aplicaciones y justificaciones apoyadas en ejemplos.`)
      .join("\n") || "Mantener el nivel demostrado y practicar conexiones entre los temas evaluados.",
  };
}

async function hashTranscript(turns: StoredTurnRow[]): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(turns));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseJsonObject(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced?.[1] ?? trimmed);
}
