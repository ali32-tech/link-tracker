# Link Placement Tracker

Static web app (HTML/CSS/JS) backed by Supabase. Roles (manager, boss, member) are set in Supabase and never shown in the portal; each person just sees their own editable name.

## Setup
1. Create a Supabase project, open SQL Editor, run `schema.sql`.
2. Put the project URL and anon key in `config.js`.
3. Authentication > URL Configuration: set Site URL and Redirect URLs to your GitHub Pages URL.
4. Open the site and sign in first: the first user becomes the Manager. Add other users in Supabase > Table Editor > `invites` (email + role `member` or `boss`); they then sign in with that email. To make someone a Director, open Supabase > Table Editor > profiles and set their role to `boss` (the Manager is `manager`).

Deployed with GitHub Pages (Settings > Pages > Deploy from branch `main`, folder `/`).
