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

ALTER TABLE evaluation_rubric_items
  ADD COLUMN IF NOT EXISTS evaluation_id UUID REFERENCES evaluations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS topic TEXT,
  ADD COLUMN IF NOT EXISTS max_score NUMERIC(5,2) NOT NULL DEFAULT 4.00,
  ADD COLUMN IF NOT EXISTS evidence_turns JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS justification TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS evaluation_rubric_items_evaluation_idx
  ON evaluation_rubric_items (evaluation_id);

ALTER TABLE evaluation_feedback
  ADD COLUMN IF NOT EXISTS evaluation_id UUID REFERENCES evaluations(id) ON DELETE CASCADE;

ALTER TABLE grade_history
  DROP CONSTRAINT IF EXISTS grade_history_attempt_id_key;

ALTER TABLE grade_history
  ADD COLUMN IF NOT EXISTS evaluation_id UUID REFERENCES evaluations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS rubric_version TEXT,
  ADD COLUMN IF NOT EXISTS calculated_grade NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS evaluator_model TEXT,
  ADD COLUMN IF NOT EXISTS evaluator_model_version TEXT,
  ADD COLUMN IF NOT EXISTS teacher_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS teacher_override_grade NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS teacher_override_reason TEXT;

CREATE INDEX IF NOT EXISTS grade_history_attempt_idx
  ON grade_history (attempt_id, recorded_at DESC);
