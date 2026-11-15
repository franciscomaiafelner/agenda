-- ============================================================================
-- AGENDA WABI-SABI · SUPABASE POSTGRESQL SCHEMA & STORAGE
-- Execute este script no SQL Editor do seu projeto Supabase
-- ============================================================================

-- Extensão para UUIDs
create extension if not exists "uuid-ossp";

-- 1. Tabela de Blocos de Categoria (Eventos sem nome: Investigação, Trabalho, Escrita, Exercício Mental, Leitura)
create table if not exists public.category_blocks (
  id text primary key,
  date_str text not null,              -- Formato YYYY-MM-DD
  category text not null check (category in (
    'Investigação',
    'Trabalho',
    'Escrita',
    'Exercício Mental',
    'Leitura'
  )),
  task_name text default '',
  rating smallint check (rating >= 0 and rating <= 5),
  notified_at timestamptz,
  start_minutes integer not null check (start_minutes >= 420 and start_minutes < 1200), -- 07:00 (420) até 20:00 (1200)
  end_minutes integer not null check (end_minutes > 420 and end_minutes <= 1200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_category_blocks_date on public.category_blocks(date_str);

-- 2. Tabela de Rotina Indisputável Personalizável (ex: Aulas da Faculdade e ajustes de rotina)
create table if not exists public.routine_rules (
  id text primary key,
  title text not null,
  subtitle text,
  tone text not null default 'espresso', -- 'moss', 'walnut', 'espresso', 'leather', 'stone', 'night'
  start_minutes integer not null check (start_minutes >= 420 and start_minutes < 1320),
  end_minutes integer not null check (end_minutes > 420 and end_minutes <= 1320),
  days_of_week integer[] not null,       -- 0 = Domingo, 1 = Segunda, ..., 6 = Sábado
  marker_minutes integer,                -- Ex: 480 (08:00 Hora do Café)
  marker_label text,
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

-- 3. Tabela de Voice Notes (Gravações + Transcrição Whisper + Síntese LLM)
create table if not exists public.voice_notes (
  id text primary key,
  date_str text not null,                -- Formato YYYY-MM-DD
  recorded_minutes integer not null,     -- Minuto exato do dia (ex: 582 = 09:42)
  recorded_time_label text not null,     -- Ex: '09:42'
  duration_seconds integer not null default 0,
  context_block text not null,           -- Ex: 'Durante Investigação' ou 'Durante Reflexão'
  poetic_title text not null,            -- Título essencial de 3-5 palavras gerado pelo LLM
  summary text not null,                 -- Resumo conciso em 1-2 frases
  key_points jsonb not null default '[]'::jsonb, -- Action items / ideias-chave em array JSON
  transcript text not null,              -- Transcrição integral do Whisper
  audio_url text,                        -- URL pública ou path no Supabase Storage
  audio_mime text default 'audio/webm',
  created_at timestamptz not null default now()
);

create index if not exists idx_voice_notes_date on public.voice_notes(date_str);

-- 4. Row Level Security (Acesso público/anon para uso pessoal ou autenticado)
alter table public.category_blocks enable row level security;
alter table public.routine_rules enable row level security;
alter table public.voice_notes enable row level security;

create policy "Permitir acesso total a category_blocks"
  on public.category_blocks for all
  using (true)
  with check (true);

create policy "Permitir acesso total a routine_rules"
  on public.routine_rules for all
  using (true)
  with check (true);

create policy "Permitir acesso total a voice_notes"
  on public.voice_notes for all
  using (true)
  with check (true);

-- 5. Bucket de Storage para os ficheiros de áudio das Voice Notes
insert into storage.buckets (id, name, public)
values ('voice-notes', 'voice-notes', true)
on conflict (id) do nothing;

create policy "Acesso público de leitura ao bucket voice-notes"
  on storage.objects for select
  using (bucket_id = 'voice-notes');

create policy "Permitir upload de áudio no bucket voice-notes"
  on storage.objects for insert
  with check (bucket_id = 'voice-notes');

create policy "Permitir remoção de áudio no bucket voice-notes"
  on storage.objects for delete
  using (bucket_id = 'voice-notes');

-- 6. Migração para Avaliação de Blocos (0 a 5 estrelas) & Subscrições Web Push
alter table public.category_blocks add column if not exists task_name text default '';
alter table public.category_blocks add column if not exists rating smallint check (rating >= 0 and rating <= 5);
alter table public.category_blocks add column if not exists notified_at timestamptz;

create table if not exists public.push_subscriptions (
  id uuid primary key default uuid_generate_v4(),
  endpoint text unique not null,
  subscription_json jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

create policy "Permitir acesso a push_subscriptions"
  on public.push_subscriptions for all
  using (true)
  with check (true);

