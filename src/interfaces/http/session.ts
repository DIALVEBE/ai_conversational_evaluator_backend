import type { Context } from "hono";

import { auth } from "@/infrastructure/auth/auth.ts";
import { findUserProfile } from "@/repositories/user-profile-repository.ts";
import type { AuthenticatedAppUser } from "@/domain/users.ts";

export async function getAuthenticatedAppUser(
  c: Context,
): Promise<AuthenticatedAppUser | null> {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session) {
    return null;
  }

  const profile = await findUserProfile(session.user.id);

  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    profile,
  };
}

