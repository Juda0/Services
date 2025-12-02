CREATE SCHEMA IF NOT EXISTS user_profiles;

CREATE TABLE IF NOT EXISTS user_profiles.users (
    id UUID PRIMARY KEY,
    username TEXT NOT NULL,
    public_key TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
