export type AppRole = "admin" | "docente" | "estudiante";

export type UserProfile = {
  authUserId: string;
  role: AppRole;
  documentNumber: string | null;
  institutionalCode: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
};

export type AuthenticatedAppUser = {
  id: string;
  name: string;
  email: string;
  profile: UserProfile | null;
};

