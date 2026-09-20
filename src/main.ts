import { zValidator } from "@hono/zod-validator";
import { OpenAI } from "openai";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { Hono } from "hono";
import * as z from "@zod/zod";

import { buildSessionInstructions } from "@/services/mod.ts";

const OPENAI_REALTIME_MODEL = "gpt-realtime-1.5";

if (!Deno.env.has("OPENAI_API_KEY")) {
  console.error("OPENAI_API_KEY env var not found");
}

const aiClient = new OpenAI({
  apiKey: Deno.env.get("OPENAI_API_KEY"),
});

const app = new Hono();

app.use(logger());
app.use("/api/*", cors());

app.post(
  "/api/conversations",
  zValidator(
    "json",
    z.object({
      topic: z.object({
        general: z.string(),
        specific: z.array(z.string()),
      }),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");

    const generalTopic = body.topic.general;
    const specificTopics = body.topic.specific;

    const instructions = buildSessionInstructions(generalTopic, specificTopics);

    const session = await aiClient.realtime.clientSecrets.create({
      session: {
        type: "realtime",
        model: OPENAI_REALTIME_MODEL,
        instructions: instructions,
      },
    });

    return c.json({
      provider: "openai",
      token: session.value,
      expiresAt: session.expires_at,
      config: {
        model: OPENAI_REALTIME_MODEL,
        instructions: instructions,
        vadMode: "server",
      },
    });
  },
);

Deno.serve(app.fetch);
