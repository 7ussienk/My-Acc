-- حساباتي — مخطط قاعدة البيانات (Supabase / Postgres)
-- التشغيل: Supabase ← SQL Editor ← الصق الملف كاملًا ← Run. آمن لإعادة التشغيل.
--
-- الفكرة: دفتر حركات واحد (transactions). الأرصدة والمستحقات ومدفوعات البنود كلها تُحسب منه.
-- الحذف «ناعم» (deleted_at) حتى تتزامن الأجهزة بشكل صحيح. كل صف يخص مستخدمه فقط (RLS).

-- ============================================================ الجداول
create table if not exists public.accounts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 60),
  sort        int  not null default 0,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table if not exists public.items (            -- بنود الصرف (مثل: القاعة، الذهب)
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 100),
  budget      numeric(14,2) check (budget is null or budget >= 0),
  sort        int  not null default 0,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table if not exists public.parties (          -- الجهات اللي لك عندها مستحقات (الشركة، أشخاص)
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 60),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table if not exists public.transactions (
  id            uuid primary key default gen_random_uuid(),   -- يولّده الجوال: إعادة الإرسال ما تكرر التسجيل
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind          text not null check (kind in ('income','expense','payment','transfer','claim','repay','adjust')),
  amount        numeric(14,2) not null,
  account_id    uuid not null references public.accounts (id),
  to_account_id uuid references public.accounts (id),         -- للتحويل فقط
  item_id       uuid references public.items (id),            -- لدفعة البند فقط
  party_id      uuid references public.parties (id),          -- للمستحقات فقط
  category      text,     -- تفصيل الدفعة / مصدر الدخل / تصنيف المصروف
  note          text,
  occurred_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  -- adjust (تسوية/رصيد افتتاحي) يقبل السالب، الباقي موجب فقط
  constraint tx_amount   check (amount <> 0 and (kind = 'adjust' or amount > 0)),
  constraint tx_transfer check ((kind = 'transfer') = (to_account_id is not null) and (to_account_id is distinct from account_id)),
  constraint tx_item     check ((kind = 'payment') = (item_id is not null)),
  constraint tx_party    check ((kind in ('claim','repay')) = (party_id is not null))
);

-- ============================================================ فهارس
create unique index if not exists accounts_name_uq on public.accounts (user_id, name) where deleted_at is null;
create unique index if not exists items_name_uq    on public.items    (user_id, name) where deleted_at is null;
create unique index if not exists parties_name_uq  on public.parties  (user_id, name) where deleted_at is null;
create index if not exists tx_sync_idx     on public.transactions (user_id, updated_at);
create index if not exists tx_occurred_idx on public.transactions (user_id, occurred_at);

-- ============================================================ updated_at بتوقيت الخادم (تعتمد عليه المزامنة)
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['accounts','items','parties','transactions'] loop
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before insert or update on public.%I for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ============================================================ الحماية: كل مستخدم يشوف ويعدّل صفوفه فقط
do $$
declare t text;
begin
  foreach t in array array['accounts','items','parties','transactions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_select on public.%I', t);
    execute format('drop policy if exists own_insert on public.%I', t);
    execute format('drop policy if exists own_update on public.%I', t);
    execute format('create policy own_select on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create policy own_insert on public.%I for insert to authenticated with check (user_id = (select auth.uid()))', t);
    execute format('create policy own_update on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    -- بدون صلاحية حذف نهائي: الحذف من التطبيق ناعم (deleted_at)
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
  end loop;
end $$;
