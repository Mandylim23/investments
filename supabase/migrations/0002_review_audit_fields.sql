alter table public.statement_transactions
  add column if not exists review_note text,
  add column if not exists source_page integer,
  add column if not exists source_line text,
  add column if not exists extracted_fields jsonb not null default '{}'::jsonb;

alter table public.monthly_reports
  add column if not exists generated_at timestamptz,
  add column if not exists notes text;
