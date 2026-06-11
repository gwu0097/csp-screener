-- Multi-tenancy: known-users table (invite-only, no self-signup).
-- password_hash is scrypt ("scrypt$N$r$p$saltB64$hashB64"); NULL until
-- an invited user accepts and sets a password. The admin row is seeded
-- by the Management API with a generated password delivered privately.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  invite_token TEXT,
  invite_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_invite_token ON users (invite_token);
