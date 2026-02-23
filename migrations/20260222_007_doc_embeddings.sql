-- Enable pgvector extension (Neon supports this natively)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS doc_embeddings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  file_path TEXT NOT NULL,
  section_header TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536) NOT NULL,
  is_locked BOOLEAN DEFAULT false,
  doc_repo_commit TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(file_path, section_header)
);

CREATE INDEX IF NOT EXISTS idx_doc_embeddings_vector
  ON doc_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 20);
