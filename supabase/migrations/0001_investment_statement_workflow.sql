create extension if not exists pgcrypto;

create table if not exists public.statement_imports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  file_name text not null,
  file_hash text not null,
  statement_period_start date,
  statement_period_end date,
  status text not null default 'review' check (status in ('review','approved','exported')),
  currency_code text not null default 'USD',
  opening_balance numeric,
  closing_balance numeric,
  total_credits numeric not null default 0,
  total_debits numeric not null default 0,
  source_text text,
  notes text
);

create unique index if not exists statement_imports_owner_file_hash_uidx on public.statement_imports(owner_id,file_hash);

create table if not exists public.statement_transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  import_id uuid not null references public.statement_imports(id) on delete cascade,
  txn_date date not null,
  description text not null,
  reference text,
  transaction_type text not null default 'cash' check (transaction_type in ('cash','buy','sale','interest','dividend','fee','transfer','other')),
  asset_class text check (asset_class is null or asset_class in ('cash','bond','equity','private_equity','fund','other')),
  security_name text,
  ticker text,
  units numeric,
  unit_price numeric,
  accrued_interest numeric not null default 0,
  amount numeric not null default 0,
  balance numeric,
  cost_value numeric,
  market_value numeric,
  unrealized_pnl numeric,
  category text not null default 'unreviewed' check (category in ('cash','investment','income','expense','transfer','unreviewed')),
  confidence numeric check (confidence is null or confidence between 0 and 1),
  is_reviewed boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists statement_transactions_import_date_idx on public.statement_transactions(import_id,txn_date,id);

create table if not exists public.monthly_reports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  import_id uuid not null references public.statement_imports(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  currency_code text not null default 'USD',
  opening_cash numeric not null default 0,
  closing_cash numeric not null default 0,
  total_income numeric not null default 0,
  total_expenses numeric not null default 0,
  realized_pnl numeric not null default 0,
  unrealized_pnl numeric not null default 0,
  total_assets numeric not null default 0,
  created_at timestamptz not null default now(),
  unique(import_id,period_start,period_end)
);

alter table public.statement_imports enable row level security;
alter table public.statement_transactions enable row level security;
alter table public.monthly_reports enable row level security;

create policy statement_imports_owner_access on public.statement_imports for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy statement_transactions_owner_access on public.statement_transactions for all to authenticated
  using (owner_id = (select auth.uid()) and exists(select 1 from public.statement_imports i where i.id=import_id and i.owner_id=(select auth.uid())))
  with check (owner_id = (select auth.uid()) and exists(select 1 from public.statement_imports i where i.id=import_id and i.owner_id=(select auth.uid())));
create policy monthly_reports_owner_access on public.monthly_reports for all to authenticated
  using (owner_id = (select auth.uid()) and exists(select 1 from public.statement_imports i where i.id=import_id and i.owner_id=(select auth.uid())))
  with check (owner_id = (select auth.uid()) and exists(select 1 from public.statement_imports i where i.id=import_id and i.owner_id=(select auth.uid())));

grant select,insert,update,delete on public.statement_imports,public.statement_transactions,public.monthly_reports to authenticated;