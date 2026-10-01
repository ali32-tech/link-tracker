-- Migration 8: a Director's own websites have no limit on the number of links. Run once in the Supabase SQL Editor.
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
    live_url = null, their_link = null, their_link_live = false, invoice_url = null,
    live_date = null, paid_date = null, status = 'link_ready'
  where id = p_id;
end $$;
