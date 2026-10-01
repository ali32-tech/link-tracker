-- Migration 5: a Director's own websites are visible only to that Director (not even the Manager).
-- Run once in the Supabase SQL Editor.
create or replace function public.visible_to_me(m uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select m = auth.uid() or not exists (select 1 from public.profiles where id = m and role = 'boss')
$$;
grant execute on function public.visible_to_me(uuid) to authenticated;

drop policy if exists websites_read on public.websites;
drop policy if exists websites_update on public.websites;
drop policy if exists websites_delete on public.websites;
create policy websites_read on public.websites for select to authenticated
  using ((public.auth_role() in ('manager','boss') and public.visible_to_me(member_id)) or member_id = auth.uid());
create policy websites_update on public.websites for update to authenticated
  using ((public.auth_role() = 'boss' and public.visible_to_me(member_id)) or (public.auth_role() in ('member','manager') and member_id = auth.uid()))
  with check ((public.auth_role() = 'boss' and public.visible_to_me(member_id)) or (public.auth_role() in ('member','manager') and member_id = auth.uid()));
create policy websites_delete on public.websites for delete to authenticated
  using ((public.auth_role() in ('manager','boss') and public.visible_to_me(member_id)) or (public.auth_role() = 'member' and member_id = auth.uid()));
