-- Migration 20: the Manager manages the team: edit names and rates, delete users. Run once in the Supabase SQL Editor.
-- (needs migration-15.sql first, which adds profiles.rate)
create or replace function public.set_person_name(p_id uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() <> 'manager' then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Name is required'; end if;
  update public.profiles set name = trim(p_name) where id = p_id;
  update public.domains set member_name = trim(p_name) where member_id = p_id;
end $$;
grant execute on function public.set_person_name(uuid, text) to authenticated;

create or replace function public.set_person_rate(p_id uuid, p_rate numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() <> 'manager' then raise exception 'Not allowed'; end if;
  if p_rate is not null and p_rate < 0 then raise exception 'Invalid rate'; end if;
  update public.profiles set rate = p_rate where id = p_id and role in ('member','manager');
end $$;
grant execute on function public.set_person_rate(uuid, numeric) to authenticated;

create or replace function public.delete_user(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() <> 'manager' then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.profiles where id = p_id and role in ('member','boss')) then raise exception 'This user cannot be deleted'; end if;
  delete from auth.users where id = p_id;
end $$;
grant execute on function public.delete_user(uuid) to authenticated;
