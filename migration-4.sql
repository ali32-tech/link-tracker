-- Migration 4: lets an invited user who already has a login (but no profile) claim their profile.
-- Run once in the Supabase SQL Editor.

create or replace function public.claim_profile() returns void
language plpgsql security definer set search_path = public as $$
declare e text; r text;
begin
  if auth.uid() is null or exists (select 1 from public.profiles where id = auth.uid()) then return; end if;
  select lower(email) into e from auth.users where id = auth.uid();
  select role into r from public.invites where email = e;
  if r is null then return; end if;
  insert into public.profiles(id, email, role) values (auth.uid(), e, r);
  delete from public.invites where email = e;
end $$;
grant execute on function public.claim_profile() to authenticated;

-- Optional one-off: create profiles right now for everyone who already has a login and a pending invite.
insert into public.profiles(id, email, role)
select u.id, lower(u.email), i.role from auth.users u join public.invites i on i.email = lower(u.email)
where not exists (select 1 from public.profiles p where p.id = u.id);
delete from public.invites i where exists (select 1 from public.profiles p where p.email = i.email);
