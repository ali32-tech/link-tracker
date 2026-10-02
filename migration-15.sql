-- Migration 15: a rate per person (editable by the Director and the Manager). Run once in the Supabase SQL Editor.
alter table public.profiles add column if not exists rate numeric;

create or replace function public.set_person_rate(p_id uuid, p_rate numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() not in ('manager','boss') then raise exception 'Not allowed'; end if;
  if p_rate is not null and p_rate < 0 then raise exception 'Invalid rate'; end if;
  update public.profiles set rate = p_rate where id = p_id and role in ('member','manager');
end $$;
grant execute on function public.set_person_rate(uuid, numeric) to authenticated;
