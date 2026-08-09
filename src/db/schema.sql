DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS session CASCADE;
DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resumed_at TIMESTAMPTZ NULL,
    INDEX idx_sessions_user (user_id)
);

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id),
    role STRING NOT NULL CHECK (role IN ('user', 'assistant')),
    content STRING NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    INDEX idx_messages_session_created (session_id, created_at)
);
