-- Link Placement Tracker: Supabase schema
-- Setup: create a Supabase project, open SQL Editor, paste this whole file and run it.
-- Then in Authentication > URL Configuration add your site URL (e.g. https://flipbite.com/link-tracker/)
-- to "Site URL" / "Redirect URLs".
-- IMPORTANT: the FIRST person to sign in becomes the Manager. Sign in yourself before inviting anyone.
-- Everyone after that must be invited (Manager > Settings > Invite) or sign-in is refused.

-- ---------- Tables ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  email text not null,
  role text not null check (role in ('manager','boss','member')),
  rate numeric,
  created_at timestamptz not null default now()
);

create table public.invites (
  email text primary key,
  role text not null check (role in ('boss','member')),
  created_at timestamptz not null default now()
);

create table public.settings (
  id int primary key default 1 check (id = 1),
  team_rate numeric not null default 7
);
insert into public.settings default values;

create table public.private_settings (
  id int primary key default 1 check (id = 1),
  boss_rate numeric not null default 10
);
insert into public.private_settings default values;

create table public.websites (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete cascade,
  url text not null,
  domain text not null,
  contact_email text,
  deal_type text not null check (deal_type in ('exchange','paid')),
  price numeric,
  da int,
  traffic text,
  notes text,
  deleted_at timestamptz,
  queued_links jsonb not null default '[]'::jsonb,
  change_request text,
  change_done_at timestamptz,
  status text not null default 'boss_review' check (status in
    ('boss_review','approved','rejected','link_ready','sent','live','invoice_received','paid')),
  possible_links int,
  target_url text,
  anchor_text text,
  reject_reason text,
  live_url text,
  their_link text,
  their_link_live boolean not null default false,
  invoice_url text,
  live_date date,
  paid_date date,
  link_history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index websites_domain_key on public.websites(domain) where deleted_at is null;
create index websites_member_idx on public.websites(member_id);

-- Public index used only for duplicate checks (members cannot read each other's websites)
create table public.domains (
  domain text primary key,
  member_id uuid not null references public.profiles(id) on delete cascade,
  member_name text,
  website_id uuid not null unique references public.websites(id) on delete cascade
);

-- ---------- Helpers ----------
create or replace function public.auth_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.normalize_domain(u text) returns text
language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(lower(trim(u)),
    '^[a-z][a-z0-9+.-]*://', ''), '^www\.', ''), '[/?#:].*$', '')
$$;

-- ---------- Sign-up gate: first user = manager, everyone else must be invited ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text; e text := lower(new.email);
begin
  if not exists (select 1 from public.profiles) then
    r := 'manager';
  else
    select role into r from public.invites where email = e;
    if r is null then raise exception 'This email has not been invited'; end if;
    delete from public.invites where email = e;
  end if;
  insert into public.profiles(id, email, role) values (new.id, e, r);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Website permissions (who may change what) ----------
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
  if r = 'member' and old.status in ('live','invoice_received','paid') then
    if (to_jsonb(new) - 'change_request' - 'change_done_at' - 'updated_at') is distinct from (to_jsonb(old) - 'change_request' - 'change_done_at' - 'updated_at') then
      raise exception 'This website is live and can no longer be changed';
    end if;
    return new;
  end if;

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
  elsif r = 'manager' then
    new.status := old.status; new.possible_links := old.possible_links; new.target_url := old.target_url;
    new.anchor_text := old.anchor_text; new.reject_reason := old.reject_reason; new.live_url := old.live_url;
    new.their_link := old.their_link; new.their_link_live := old.their_link_live; new.invoice_url := old.invoice_url;
    new.live_date := old.live_date; new.paid_date := old.paid_date; new.link_history := old.link_history;
    new.queued_links := old.queued_links; new.change_request := old.change_request; new.change_done_at := old.change_done_at;
    new.domain := public.normalize_domain(new.url);
    if new.domain = '' then raise exception 'Invalid website URL'; end if;
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

create trigger websites_guard_trg before insert or update on public.websites
  for each row execute function public.websites_guard();

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

create trigger websites_sync_domains_trg after insert or update of domain, deleted_at or delete on public.websites
  for each row execute function public.websites_sync_domains();

-- ---------- RPCs ----------
create or replace function public.set_my_name(n text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(trim(n), '') = '' then raise exception 'Name is required'; end if;
  update public.profiles set name = trim(n) where id = auth.uid();
  update public.domains set member_name = trim(n) where member_id = auth.uid();
end $$;

create or replace function public.set_user_role(p_id uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() <> 'manager' then raise exception 'Not allowed'; end if;
  if p_role not in ('member','boss') then raise exception 'Invalid role'; end if;
  update public.profiles set role = p_role where id = p_id and role <> 'manager';
end $$;

create or replace function public.set_person_rate(p_id uuid, p_rate numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.auth_role() not in ('manager','boss') then raise exception 'Not allowed'; end if;
  if p_rate is not null and p_rate < 0 then raise exception 'Invalid rate'; end if;
  update public.profiles set rate = p_rate where id = p_id and role in ('member','manager');
end $$;
grant execute on function public.set_person_rate(uuid, numeric) to authenticated;

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

create or replace function public.visible_to_me(m uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select m = auth.uid() or not exists (select 1 from public.profiles where id = m and role = 'boss')
$$;
grant execute on function public.visible_to_me(uuid) to authenticated;

-- ---------- Row Level Security ----------
alter table public.profiles enable row level security;
alter table public.invites enable row level security;
alter table public.settings enable row level security;
alter table public.private_settings enable row level security;
alter table public.websites enable row level security;
alter table public.domains enable row level security;

create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.auth_role() in ('manager','boss'));

create policy invites_manager on public.invites for all to authenticated
  using (public.auth_role() = 'manager') with check (public.auth_role() = 'manager');

create policy settings_read on public.settings for select to authenticated
  using (public.auth_role() in ('manager','member','boss'));
create policy settings_write on public.settings for update to authenticated
  using (public.auth_role() = 'manager') with check (public.auth_role() = 'manager');

create policy private_settings_manager on public.private_settings for all to authenticated
  using (public.auth_role() = 'manager') with check (public.auth_role() = 'manager');
create policy private_settings_boss_read on public.private_settings for select to authenticated
  using (public.auth_role() = 'boss');

create policy domains_read on public.domains for select to authenticated using (true);

create policy websites_read on public.websites for select to authenticated
  using ((public.auth_role() in ('manager','boss') and public.visible_to_me(member_id)) or member_id = auth.uid());
create policy websites_update on public.websites for update to authenticated
  using ((public.auth_role() in ('boss','manager') and public.visible_to_me(member_id)) or (public.auth_role() in ('member','manager') and member_id = auth.uid()))
  with check ((public.auth_role() in ('boss','manager') and public.visible_to_me(member_id)) or (public.auth_role() in ('member','manager') and member_id = auth.uid()));
create policy websites_delete on public.websites for delete to authenticated
  using ((public.auth_role() in ('manager','boss') and public.visible_to_me(member_id)) or (public.auth_role() = 'member' and member_id = auth.uid() and status not in ('live','invoice_received','paid')));
create policy websites_insert on public.websites for insert to authenticated
  with check (public.auth_role() = 'manager' or (public.auth_role() in ('member','boss') and member_id = auth.uid()));

-- ---------- Privileges ----------
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on function public.auth_role() to authenticated;
grant execute on function public.set_my_name(text) to authenticated;
grant execute on function public.set_user_role(uuid, text) to authenticated;
grant execute on function public.add_next_link(uuid, text, text, numeric) to authenticated;

-- ---------- Realtime ----------
alter publication supabase_realtime add table public.websites;
