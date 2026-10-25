import { query } from "@/infrastructure/database/postgres.ts";
import type { AppRole, UserProfile } from "@/domain/users.ts";

type UserProfileRow = {
  auth_user_id: string;
  role: AppRole;
  document_number: string | null;
  institutional_code: string | null;
  is_active: boolean;
};

export async function findUserProfile(
  authUserId: string,
): Promise<UserProfile | null> {
  const rows = await query<UserProfileRow>(
    `
      SELECT auth_user_id, role, document_number, institutional_code, is_active
      FROM user_profiles
      WHERE auth_user_id = $1
    `,
    [authUserId],
  );

  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    authUserId: row.auth_user_id,
    role: row.role,
    documentNumber: row.document_number,
    institutionalCode: row.institutional_code,
    isActive: row.is_active,
  };
}

export async function upsertUserProfile(input: {
  authUserId: string;
  role: AppRole;
  documentNumber?: string;
  institutionalCode?: string;
}): Promise<void> {
  await query(
    `
      INSERT INTO user_profiles (
        auth_user_id,
        role,
        document_number,
        institutional_code
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (auth_user_id)
      DO UPDATE SET
        role = EXCLUDED.role,
        document_number = EXCLUDED.document_number,
        institutional_code = EXCLUDED.institutional_code,
        updated_at = now()
    `,
    [
      input.authUserId,
      input.role,
      input.documentNumber ?? null,
      input.institutionalCode ?? null,
    ],
  );
}

