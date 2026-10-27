CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE app_role AS ENUM ('admin', 'docente', 'estudiante');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'live_talk_status') THEN
    CREATE TYPE live_talk_status AS ENUM ('draft', 'active', 'closed');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'evaluation_attempt_status') THEN
    CREATE TYPE evaluation_attempt_status AS ENUM ('in_progress', 'completed', 'cancelled');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE,
  image TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "accessTokenExpiresAt" TIMESTAMPTZ,
  "refreshTokenExpiresAt" TIMESTAMPTZ,
  scope TEXT,
  "idToken" TEXT,
  password TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_user_id_idx ON account ("userId");
CREATE UNIQUE INDEX IF NOT EXISTS account_provider_account_idx ON account ("providerId", "accountId");

CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_profiles (
  auth_user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  document_number TEXT UNIQUE,
  institutional_code TEXT UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_profiles_role_idx ON user_profiles (role);

CREATE TABLE IF NOT EXISTS academic_programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS academic_spaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES academic_programs(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  credits SMALLINT,
  semester SMALLINT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (program_id, code)
);

CREATE INDEX IF NOT EXISTS academic_spaces_program_idx ON academic_spaces (program_id);

CREATE TABLE IF NOT EXISTS program_students (
  program_id UUID NOT NULL REFERENCES academic_programs(id) ON DELETE CASCADE,
  student_user_id TEXT NOT NULL REFERENCES user_profiles(auth_user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, student_user_id)
);

CREATE TABLE IF NOT EXISTS academic_space_teachers (
  academic_space_id UUID NOT NULL REFERENCES academic_spaces(id) ON DELETE CASCADE,
  teacher_user_id TEXT NOT NULL REFERENCES user_profiles(auth_user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (academic_space_id, teacher_user_id)
);

CREATE TABLE IF NOT EXISTS academic_space_students (
  academic_space_id UUID NOT NULL REFERENCES academic_spaces(id) ON DELETE CASCADE,
  student_user_id TEXT NOT NULL REFERENCES user_profiles(auth_user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (academic_space_id, student_user_id)
);

CREATE TABLE IF NOT EXISTS live_talks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  academic_space_id UUID NOT NULL REFERENCES academic_spaces(id) ON DELETE CASCADE,
  created_by_teacher_user_id TEXT NOT NULL REFERENCES user_profiles(auth_user_id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  general_topic TEXT NOT NULL,
  status live_talk_status NOT NULL DEFAULT 'draft',
  opens_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS live_talks_academic_space_idx ON live_talks (academic_space_id);
CREATE INDEX IF NOT EXISTS live_talks_status_idx ON live_talks (status);

CREATE TABLE IF NOT EXISTS live_talk_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  live_talk_id UUID NOT NULL REFERENCES live_talks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (live_talk_id, name)
);

CREATE INDEX IF NOT EXISTS live_talk_topics_live_talk_idx ON live_talk_topics (live_talk_id);

CREATE TABLE IF NOT EXISTS evaluation_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  live_talk_id UUID NOT NULL REFERENCES live_talks(id) ON DELETE RESTRICT,
  student_user_id TEXT NOT NULL REFERENCES user_profiles(auth_user_id) ON DELETE RESTRICT,
  status evaluation_attempt_status NOT NULL DEFAULT 'in_progress',
  realtime_session_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  final_score NUMERIC(5,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evaluation_attempts_student_idx ON evaluation_attempts (student_user_id);
CREATE INDEX IF NOT EXISTS evaluation_attempts_live_talk_idx ON evaluation_attempts (live_talk_id);

CREATE TABLE IF NOT EXISTS evaluation_transcript_turns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES evaluation_attempts(id) ON DELETE CASCADE,
  turn_id INTEGER NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('student', 'evaluator')),
  text TEXT NOT NULL,
  occurred_at TIMESTAMPTZ,
  source_message_id TEXT,
  source_event_type TEXT,
  realtime_item_id TEXT,
  realtime_response_id TEXT,
  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, turn_id)
);

CREATE INDEX IF NOT EXISTS evaluation_transcript_turns_attempt_idx
  ON evaluation_transcript_turns (attempt_id, turn_id);

CREATE TABLE IF NOT EXISTS evaluation_realtime_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES evaluation_attempts(id) ON DELETE CASCADE,
  event_order INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  provider_event_id TEXT,
  source_message_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, event_order)
);

CREATE INDEX IF NOT EXISTS evaluation_realtime_events_attempt_idx
  ON evaluation_realtime_events (attempt_id, event_order);

CREATE TABLE IF NOT EXISTS evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES evaluation_attempts(id) ON DELETE CASCADE,
  rubric_version TEXT NOT NULL,
  evaluator_model TEXT NOT NULL,
  evaluator_model_version TEXT,
  grade_scale_max NUMERIC(5,2) NOT NULL DEFAULT 5.00,
  transcript_hash TEXT NOT NULL,
  conversation_summary TEXT,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evaluations_attempt_idx ON evaluations (attempt_id, created_at DESC);

CREATE TABLE IF NOT EXISTS evaluation_rubric_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id UUID REFERENCES evaluations(id) ON DELETE CASCADE,
  attempt_id UUID NOT NULL REFERENCES evaluation_attempts(id) ON DELETE CASCADE,
  live_talk_topic_id UUID REFERENCES live_talk_topics(id) ON DELETE SET NULL,
  topic TEXT,
  criterion TEXT NOT NULL,
  performance_level TEXT NOT NULL,
  score NUMERIC(5,2) NOT NULL,
  max_score NUMERIC(5,2) NOT NULL DEFAULT 4.00,
  evidence TEXT,
  evidence_turns JSONB NOT NULL DEFAULT '[]'::jsonb,
  justification TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evaluation_rubric_items_attempt_idx ON evaluation_rubric_items (attempt_id);
CREATE INDEX IF NOT EXISTS evaluation_rubric_items_evaluation_idx ON evaluation_rubric_items (evaluation_id);

CREATE TABLE IF NOT EXISTS evaluation_feedback (
  attempt_id UUID PRIMARY KEY REFERENCES evaluation_attempts(id) ON DELETE CASCADE,
  evaluation_id UUID REFERENCES evaluations(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  strengths TEXT,
  improvement_opportunities TEXT,
  recommendations TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grade_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES evaluation_attempts(id) ON DELETE RESTRICT,
  evaluation_id UUID REFERENCES evaluations(id) ON DELETE RESTRICT,
  rubric_version TEXT,
  student_user_id TEXT NOT NULL REFERENCES user_profiles(auth_user_id) ON DELETE RESTRICT,
  academic_space_id UUID NOT NULL REFERENCES academic_spaces(id) ON DELETE RESTRICT,
  live_talk_id UUID NOT NULL REFERENCES live_talks(id) ON DELETE RESTRICT,
  score NUMERIC(5,2) NOT NULL,
  calculated_grade NUMERIC(5,2),
  evaluator_model TEXT,
  evaluator_model_version TEXT,
  teacher_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  teacher_override_grade NUMERIC(5,2),
  teacher_override_reason TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS grade_history_student_idx ON grade_history (student_user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS grade_history_academic_space_idx ON grade_history (academic_space_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS grade_history_attempt_idx ON grade_history (attempt_id, recorded_at DESC);
