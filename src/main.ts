import { zValidator } from "@hono/zod-validator";
import { OpenAI } from "openai";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { Hono } from "hono";
import * as z from "@zod/zod";

import { auth } from "@/infrastructure/auth/auth.ts";
import { query } from "@/infrastructure/database/postgres.ts";
import { adminRoutes } from "@/interfaces/http/admin.ts";
import { getAuthenticatedAppUser } from "@/interfaces/http/session.ts";
import { studentRoutes } from "@/interfaces/http/student.ts";
import { teacherRoutes } from "@/interfaces/http/teacher.ts";
import { buildSessionInstructions } from "@/services/mod.ts";

const OPENAI_REALTIME_MODEL = "gpt-realtime-1.5";
const FRONTEND_ORIGINS = getFrontendOrigins();

if (!Deno.env.has("OPENAI_API_KEY")) {
  console.error("OPENAI_API_KEY env var not found");
}

const aiClient = new OpenAI({
  apiKey: Deno.env.get("OPENAI_API_KEY"),
});

const app = new Hono();

app.use(logger());
app.use(
  "/api/*",
  cors({
    origin: FRONTEND_ORIGINS,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.all("/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/admin", adminRoutes);
app.route("/api/teacher", teacherRoutes);
app.route("/api/student", studentRoutes);

app.get("/api/me", async (c) => {
  const user = await getAuthenticatedAppUser(c);

  if (!user) {
    return c.json({ message: "No autenticado" }, 401);
  }

  if (!user.profile?.isActive) {
    return c.json({ message: "Usuario inactivo o sin perfil asignado" }, 403);
  }

  return c.json({ user });
});

app.post(
  "/api/conversations",
  zValidator(
    "json",
    z.object({
      liveTalkId: z.uuid(),
      attemptId: z.uuid().optional(),
    }),
  ),
  async (c) => {
    const user = await getAuthenticatedAppUser(c);

    if (!user) {
      return c.json({ message: "No autenticado" }, 401);
    }

    if (!user.profile?.isActive) {
      return c.json({ message: "Usuario inactivo o sin perfil asignado" }, 403);
    }

    if (user.profile.role !== "estudiante") {
      return c.json({ message: "Solo estudiantes pueden iniciar live talks" }, 403);
    }

    const body = c.req.valid("json");

    const liveTalkRows = await query<{
      academic_space_id: string;
      general_topic: string;
      topics: string[] | null;
    }>(
      `
        SELECT
          lt.academic_space_id::text,
          lt.general_topic,
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
          lt.id = $1
          AND ass.student_user_id = $2
          AND lt.status = 'active'
          AND s.is_active = TRUE
          AND p.is_active = TRUE
          AND (lt.opens_at IS NULL OR lt.opens_at <= now())
          AND (lt.closes_at IS NULL OR lt.closes_at >= now())
        GROUP BY lt.id
      `,
      [body.liveTalkId, user.id],
    );

    const liveTalk = liveTalkRows[0];

    if (!liveTalk) {
      return c.json({ message: "Live talk no disponible para este estudiante" }, 403);
    }

    const generalTopic = liveTalk.general_topic;
    const specificTopics = liveTalk.topics ?? [];

    const instructions = buildSessionInstructions(generalTopic, specificTopics);

    let attemptId = body.attemptId ?? "";
    const createdAttempt = !attemptId;

    if (attemptId) {
      const attemptRows = await query<{ id: string }>(
        `
          SELECT id::text
          FROM evaluation_attempts
          WHERE id = $1
            AND live_talk_id = $2
            AND student_user_id = $3
            AND status = 'in_progress'
        `,
        [attemptId, body.liveTalkId, user.id],
      );

      if (!attemptRows[0]) {
        return c.json({ message: "Intento no disponible para refrescar token" }, 404);
      }
    } else {
      const attemptRows = await query<{ id: string }>(
        `
          INSERT INTO evaluation_attempts (
            live_talk_id,
            student_user_id,
            status
          )
          VALUES ($1, $2, 'in_progress')
          RETURNING id::text
        `,
        [body.liveTalkId, user.id],
      );

      attemptId = attemptRows[0].id;
    }

    let session;

    try {
      session = await aiClient.realtime.clientSecrets.create({
        session: {
          type: "realtime",
          model: OPENAI_REALTIME_MODEL,
          instructions: instructions,
        },
      });
    } catch (error) {
      if (createdAttempt) {
        await query(
          `
            UPDATE evaluation_attempts
            SET status = 'cancelled', completed_at = now(), updated_at = now()
            WHERE id = $1
          `,
          [attemptId],
        );
      }

      console.error(error);
      return c.json({ message: "No fue posible iniciar la sesión conversacional" }, 502);
    }

    await query(
      `
        UPDATE evaluation_attempts
        SET realtime_session_id = $2, updated_at = now()
        WHERE id = $1
      `,
      [attemptId, getRealtimeSessionId(session) ?? attemptId],
    );

    return c.json({
      provider: "openai",
      token: session.value,
      expiresAt: normalizeClientExpiresAt(session.expires_at),
      attemptId,
      config: {
        model: OPENAI_REALTIME_MODEL,
        instructions: instructions,
        vadMode: "server",
      },
    });
  },
);

Deno.serve(app.fetch);

function getFrontendOrigins() {
  const configuredOrigins = [
    Deno.env.get("FRONTEND_URL"),
    Deno.env.get("FRONTEND_URLS"),
  ]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(
    new Set([
      ...configuredOrigins,
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]),
  );
}

function normalizeClientExpiresAt(expiresAt: number) {
  return expiresAt < 10_000_000_000 ? expiresAt * 1000 : expiresAt;
}

function getRealtimeSessionId(session: unknown) {
  if (typeof session !== "object" || session === null || !("id" in session)) {
    return null;
  }

  const id = (session as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}
