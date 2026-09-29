-- Run once in Supabase SQL editor (existing project).
alter table public.websites alter column traffic type text using traffic::text;

drop policy if exists websites_update on public.websites;
create policy websites_update on public.websites for update to authenticated
  using (public.auth_role() = 'boss' or (public.auth_role() in ('member','manager') and member_id = auth.uid()))
  with check (public.auth_role() = 'boss' or (public.auth_role() in ('member','manager') and member_id = auth.uid()));

create or replace function public.websites_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := public.auth_role();
begin
  if tg_op = 'INSERT' then
    if r not in ('member','manager') then raise exception 'Not allowed'; end if;
    new.domain := public.normalize_domain(new.url);
    if new.domain = '' then raise exception 'Invalid website URL'; end if;
    if r = 'member' then new.member_id := auth.uid(); end if;
    new.status := 'boss_review';
    new.possible_links := null; new.target_url := null; new.anchor_text := null;
    new.reject_reason := null; new.live_url := null; new.their_link := null;
    new.their_link_live := false; new.invoice_url := null;
    new.live_date := null; new.paid_date := null; new.link_history := '[]'::jsonb;
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;

  new.updated_at := now();
  new.id := old.id; new.member_id := old.member_id; new.created_at := old.created_at;
  if current_setting('app.bypass_guard', true) = '1' then return new; end if;

  if r = 'member' or (r = 'manager' and old.member_id = auth.uid()) then
    new.possible_links := old.possible_links; new.target_url := old.target_url;
    new.anchor_text := old.anchor_text; new.reject_reason := old.reject_reason;
    new.their_link_live := old.their_link_live; new.paid_date := old.paid_date;
    new.live_date := old.live_date; new.link_history := old.link_history;
    new.domain := public.normalize_domain(new.url);
    if new.domain = '' then raise exception 'Invalid website URL'; end if;
    if new.status is distinct from old.status then
      if not ((old.status = 'link_ready' and new.status = 'sent')
           or (old.status = 'sent' and new.status = 'live')) then
        raise exception 'You cannot set this status';
      end if;
      if new.status = 'live' and coalesce(trim(new.live_url), '') = '' then
        raise exception 'The live URL is required';
      end if;
    end if;
  elsif r = 'boss' then
    new.url := old.url; new.domain := old.domain; new.contact_email := old.contact_email;
    new.deal_type := old.deal_type; new.price := old.price; new.da := old.da;
    new.traffic := old.traffic; new.notes := old.notes; new.live_url := old.live_url;
    new.their_link := old.their_link; new.invoice_url := old.invoice_url;
    new.live_date := old.live_date; new.link_history := old.link_history;
    if new.status is distinct from old.status
       and new.status not in ('boss_review','approved','rejected','link_ready','invoice_received','paid') then
      raise exception 'The Director cannot set this status';
    end if;
    if new.status in ('approved','link_ready') and coalesce(new.possible_links, 0) < 1 then
      raise exception 'Possible links is required';
    end if;
    if new.status = 'link_ready'
       and (coalesce(trim(new.target_url), '') = '' or coalesce(trim(new.anchor_text), '') = '') then
      raise exception 'Target URL and anchor text are required';
    end if;
    if new.status in ('invoice_received','paid') and coalesce(trim(new.live_url), '') = '' then
      raise exception 'The link must be live first';
    end if;
  else
    raise exception 'Not allowed';
  end if;

  if new.status in ('live','invoice_received','paid') and new.live_date is null then
    new.live_date := current_date;
  end if;
  if new.status = 'paid' then
    if new.paid_date is null then new.paid_date := current_date; end if;
  else
    new.paid_date := null;
  end if;
  return new;
end $$;

create or replace function public.set_user_role(p_id uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() <> 'manager' then raise exception 'Not allowed'; end if;
  if p_role not in ('member','boss') then raise exception 'Invalid role'; end if;
  update public.profiles set role = p_role where id = p_id and role <> 'manager';
end $$;

grant execute on function public.set_user_role(uuid, text) to authenticated;
