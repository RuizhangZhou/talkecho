-- Add source column to messages table for system audio vs microphone
ALTER TABLE messages ADD COLUMN source TEXT;

