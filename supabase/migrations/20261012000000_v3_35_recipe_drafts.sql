-- v3.35: recipe drafts, prepared ahead of time.
--
-- Most saved recipes are a name and nothing else, so the grocery list cannot
-- build itself from the meal plan. Kitchen → Recipes → Fill them in drafts
-- them, but one at a time, while someone waits most of a minute for each. Now
-- a nightly job drafts the bare ones ahead of time
-- (netlify/functions/lib/recipedrafts.mjs) and keeps each draft as a record of
-- its own, `recipedraft~<recipe id>`, until someone looks at it: Save puts it
-- into the recipe and removes it, Skip keeps it aside. Nothing reaches a
-- recipe without a tap on Save.
--
-- One statement, additive and safe to run twice: the kind, the v3.31 way.
-- Read as a recipe is read — the household's by kind, not personal and not
-- decided per record — since a draft is a proposal for the recipe, and
-- whoever can read the recipe must see the draft waiting for it. The job
-- writes each one as the recipe's own owner, through sync_posts_as (v3.34).
--
-- Apply it before the functions and the app build that write the kind are
-- deployed: until then sync_posts refuses the rows, the job's writes come back
-- rejected, and a device re-pushes a refused skip forever. It goes in the same
-- `supabase db push` as 20261011000000_v3_34_service_writes.

insert into public.record_kinds (kind, personal, shared_default)
values ('recipedraft', false, null)
on conflict (kind) do nothing;
