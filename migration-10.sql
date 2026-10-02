-- Migration 10: a website in the Trash no longer blocks adding the same domain again. Run once in the Supabase SQL Editor.
drop index if exists public.websites_domain_key;
create unique index websites_domain_key on public.websites(domain) where deleted_at is null;

create or replace function public.websites_sync_domains() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    delete from public.domains where website_id = old.id;
    return old;
  elsif tg_op = 'INSERT' then
    if new.deleted_at is null then
      insert into public.domains(domain, member_id, member_name, website_id)
      values (new.domain, new.member_id,
              (select coalesce(name, email) from public.profiles where id = new.member_id), new.id);
    end if;
  else
    if new.deleted_at is not null then
      delete from public.domains where website_id = new.id;
    elsif exists (select 1 from public.domains where website_id = new.id) then
      update public.domains set domain = new.domain where website_id = new.id;
    else
      insert into public.domains(domain, member_id, member_name, website_id)
      values (new.domain, new.member_id,
              (select coalesce(name, email) from public.profiles where id = new.member_id), new.id);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists websites_sync_domains_trg on public.websites;
create trigger websites_sync_domains_trg after insert or update of domain, deleted_at or delete on public.websites
  for each row execute function public.websites_sync_domains();

delete from public.domains where website_id in (select id from public.websites where deleted_at is not null);
