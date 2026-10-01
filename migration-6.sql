-- Migration 6: invoice PDF uploads. Run once in the Supabase SQL Editor.
-- Creates a public bucket "invoices" (PDF only, max 10 MB). File names are random UUIDs, so links are not guessable.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoices', 'invoices', true, 10485760, array['application/pdf'])
on conflict (id) do update set public = true, file_size_limit = 10485760, allowed_mime_types = array['application/pdf'];

drop policy if exists invoices_upload on storage.objects;
create policy invoices_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'invoices' and (storage.foldername(name))[1] = auth.uid()::text);
