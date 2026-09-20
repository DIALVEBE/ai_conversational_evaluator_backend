import { zValidator } from "@hono/zod-validator";
import { OpenAI } from "openai";
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

app.use("/api/*", cors());

app.post(
  "/api/conversations",
  zValidator(
    "json",
    z.object({
      topics: z.array(z.string()),
    }),
  ),
  async (c) => {
    const topics = c.req.valid("json").topics;

    const session = await aiClient.realtime.clientSecrets.create({
      session: {
        type: "realtime",
        model: OPENAI_REALTIME_MODEL,
        instructions: buildSessionInstructions(topics),
      },
    });

    return c.json({
      provider: "openai",
      token: session.value,
      expiresAt: session.expires_at,
      config: {
        model: OPENAI_REALTIME_MODEL,
      },
    });
  },
);

Deno.serve(app.fetch);
