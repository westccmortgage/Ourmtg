-- ============================================================
-- 039 — OurMTG site settings (owner-editable, publicly readable).
--
-- A single JSON row the owner edits from the LO dashboard (no code, no CMS):
--   • rate       — the live interest-rate assumption for the calculator + builder
--   • loanTypes  — the loan programs shown in intake dropdowns
--   • home       — marketing copy for the home hero (headline/sub)
--
-- Publicly readable because it drives PUBLIC pages (home, /apply, /plan,
-- calculators) that render before login. It contains only marketing/config data —
-- never anything sensitive. Writes are service-role only, through
-- portal-settings-set (owner/admin gated). Safe to re-run.
-- ============================================================

create table if not exists public.site_settings (
  id          text primary key default 'default',
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.site_settings enable row level security;

-- Anyone may read the settings (they render on public pages).
drop policy if exists "public read site_settings" on public.site_settings;
create policy "public read site_settings" on public.site_settings
  for select using (true);
-- No write policy: the gateway (service role) writes after an owner/admin check.

-- Seed the default row with today's values (only if absent).
insert into public.site_settings (id, data)
values ('default', jsonb_build_object(
  'rate', 7,
  'loanTypes', jsonb_build_array('Conventional','FHA','VA','Jumbo','USDA','Non-QM','DSCR'),
  'home', jsonb_build_object(
    'headline', 'the mortgage,',
    'headlineAlt', 'minus the noise.',
    'sub', 'One secure link: upload documents from your phone, watch your loan move stage by stage, and always know what''s next — without a single “just checking in” call.'
  )
))
on conflict (id) do nothing;
