import { OpenAI } from "openai";
import { cors } from "hono/cors";
import { Hono } from "hono";

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

app.post("/api/conversations/token", async (c) => {
  const topicsToEvaluate = [
    "OOP Encapsulation",
    "OOP Abstraction",
    "OOP Inheritance",
    "OOP Polymorphism",
  ];

  const session = await aiClient.realtime.clientSecrets.create({
    session: {
      type: "realtime",
      model: OPENAI_REALTIME_MODEL,
      instructions: buildSessionInstructions(topicsToEvaluate),
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
});

Deno.serve(app.fetch);
