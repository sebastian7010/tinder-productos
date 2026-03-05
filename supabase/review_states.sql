create table if not exists public.review_states (
  session_id text not null,
  reviewer_id text not null,
  decisions jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint review_states_pkey primary key (session_id, reviewer_id)
);

create index if not exists review_states_session_idx on public.review_states (session_id);
