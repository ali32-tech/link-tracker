-- Migration 14: the Director can read the payout rates (needed for the Team managing page). Run once in the Supabase SQL Editor.
drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select to authenticated
  using (public.auth_role() in ('manager','member','boss'));

drop policy if exists private_settings_boss_read on public.private_settings;
create policy private_settings_boss_read on public.private_settings for select to authenticated
  using (public.auth_role() = 'boss');
