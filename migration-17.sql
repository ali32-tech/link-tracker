-- Migration 17: tell the member when the admin has updated a link. Run once in the Supabase SQL Editor.
alter table public.websites add column if not exists change_done_at timestamptz;

create or replace function public.websites_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := public.auth_role();
begin
  if tg_op = 'INSERT' then
    if r not in ('member','manager','boss') then raise exception 'Not allowed'; end if;
    new.domain := public.normalize_domain(new.url);
    if new.domain = '' then raise exception 'Invalid website URL'; end if;
    if r in ('member','boss') then new.member_id := auth.uid(); end if;
    if r = 'boss' then
      new.status := 'approved';
      new.possible_links := greatest(coalesce(new.possible_links, 1), 1);
    else
      new.status := 'boss_review';
      new.possible_links := null;
    end if;
    new.target_url := null; new.anchor_text := null;
    new.reject_reason := null; new.live_url := null; new.their_link := null;
    new.their_link_live := false; new.invoice_url := null;
    new.live_date := null; new.paid_date := null; new.link_history := '[]'::jsonb;
    new.deleted_at := null; new.queued_links := '[]'::jsonb; new.change_request := null; new.change_done_at := null;
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;

  new.updated_at := now();
  new.id := old.id; new.member_id := old.member_id; new.created_at := old.created_at;
  if current_setting('app.bypass_guard', true) = '1' then return new; end if;
  if r <> 'boss' and old.member_id <> auth.uid() then new.deleted_at := old.deleted_at; end if;

  if r = 'member' or (r = 'manager' and old.member_id = auth.uid()) then
    new.queued_links := old.queued_links;
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
  elsif r = 'boss' and old.member_id = auth.uid() then
    new.domain := public.normalize_domain(new.url);
    if new.domain = '' then raise exception 'Invalid website URL'; end if;
    if new.status in ('approved','link_ready') and coalesce(new.possible_links, 0) < 1 then
      raise exception 'Possible links is required';
    end if;
    if new.status = 'link_ready'
       and (coalesce(trim(new.target_url), '') = '' or coalesce(trim(new.anchor_text), '') = '') then
      raise exception 'Target URL and anchor text are required';
    end if;
    if new.status in ('live','invoice_received','paid') and coalesce(trim(new.live_url), '') = '' then
      raise exception 'The live URL is required';
    end if;
  elsif r = 'boss' then
    new.url := old.url; new.domain := old.domain; new.contact_email := old.contact_email;
    new.deal_type := old.deal_type; new.price := old.price; new.da := old.da;
    new.traffic := old.traffic; new.notes := old.notes;
    new.live_date := old.live_date;
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

create or replace function public.add_next_link(p_id uuid, p_target text, p_anchor text, p_price numeric)
returns void language plpgsql security definer set search_path = public as $$
declare w public.websites%rowtype;
begin
  if public.auth_role() <> 'boss' then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_target), '') = '' or coalesce(trim(p_anchor), '') = '' then
    raise exception 'Target URL and anchor text are required';
  end if;
  select * into w from public.websites where id = p_id for update;
  if not found then raise exception 'Website not found'; end if;
  if not ((w.deal_type = 'paid' and w.status = 'paid')
       or (w.deal_type = 'exchange' and w.status = 'live' and w.their_link_live)) then
    raise exception 'The current link is not finished yet';
  end if;
  if w.member_id <> auth.uid() and jsonb_array_length(w.link_history) + 1 >= coalesce(w.possible_links, 0) then
    raise exception 'No more links are possible on this website';
  end if;
  perform set_config('app.bypass_guard', '1', true);
  update public.websites set
    link_history = link_history || jsonb_build_array(jsonb_build_object(
      'target_url', w.target_url, 'anchor_text', w.anchor_text, 'live_url', w.live_url,
      'their_link', w.their_link, 'invoice_url', w.invoice_url, 'live_date', w.live_date,
      'paid_date', w.paid_date, 'price', w.price)),
    target_url = trim(p_target), anchor_text = trim(p_anchor),
    price = case when w.deal_type = 'paid' and p_price is not null then p_price else w.price end,
    live_url = null, their_link = null, their_link_live = false, invoice_url = null, change_request = null, change_done_at = null,
    live_date = null, paid_date = null, status = 'link_ready'
  where id = p_id;
end $$;
