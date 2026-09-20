import { OpenAIRealtimeModel, openaiRealtimeToken } from "@tanstack/ai-openai";
import { realtimeToken } from "@tanstack/ai";
import { cors } from "hono/cors";
import { Hono } from "hono";

const REALTIME_MODEL: OpenAIRealtimeModel = "gpt-realtime";

if (!Deno.env.has("OPENAI_API_KEY")) {
  console.error("OPENAI_API_KEY env var not set");
}

const app = new Hono();

app.use("/api/*", cors());

/**
 * @todo create directly a Realtime session with instructions and return secret
 */
app.post("/api/conversations/token", async (c) => {
  const token = await realtimeToken({
    adapter: openaiRealtimeToken({
      model: REALTIME_MODEL,
    }),
  });

  return c.json(token);
});

Deno.serve(app.fetch);
