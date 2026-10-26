import { betterAuth } from "better-auth";

import { pool } from "@/infrastructure/database/postgres.ts";

const betterAuthSecret = Deno.env.get("BETTER_AUTH_SECRET");
const betterAuthUrl = Deno.env.get("BETTER_AUTH_URL") ?? "http://localhost:8000";
const frontendOrigins = getFrontendOrigins();

if (!betterAuthSecret) {
  console.error("BETTER_AUTH_SECRET env var not found");
}

export const auth = betterAuth({
  baseURL: betterAuthUrl,
  secret: betterAuthSecret,
  database: pool,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 6,
  },
  trustedOrigins: frontendOrigins,
  advanced: {
    database: {
      joins: true,
    },
  },
});

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
