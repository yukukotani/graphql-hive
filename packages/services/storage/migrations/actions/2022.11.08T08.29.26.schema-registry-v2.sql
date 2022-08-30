--
-- Add new things
--
CREATE TYPE registry_action AS ENUM ('ADD', 'MODIFY', 'DELETE', 'N/A');

CREATE TABLE public.registry_actions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  author text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT NOW(),
  service_name text,
  service_url text,
  sdl text,
  metadata text,
  commit text NOT NULL,
  action registry_action NOT NULL,
  target_id uuid NOT NULL REFERENCES public.targets(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE
);

CREATE TABLE public.registry_versions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at timestamp with time zone NOT NULL DEFAULT NOW(),
  is_composable boolean NOT NULL,
  base_schema text,
  target_id uuid NOT NULL REFERENCES public.targets(id) ON DELETE CASCADE,
  action_id uuid NOT NULL REFERENCES public.registry_actions(id) ON DELETE CASCADE
);

CREATE TABLE public.registry_version_action (
  version_id uuid NOT NULL REFERENCES public.registry_versions(id) ON DELETE CASCADE,
  action_id uuid NOT NULL REFERENCES public.registry_actions(id) ON DELETE CASCADE,
  PRIMARY KEY(version_id, action_id)
);

ALTER TABLE public.projects
  ADD COLUMN legacy_registry_model boolean NOT NULL DEFAULT FALSE;

--
-- migrate the state
--

-- 1. Copy `commits` to `registry_actions`
INSERT INTO public.registry_actions (
  id,
  author,
  created_at,
  service_name,
  service_url,
  sdl,
  metadata,
  commit,
  action,
  target_id,
  project_id
) SELECT 
  id,
  author,
  created_at,
--- Copy `commits.service` to `registry_actions.service_name`
  service as service_name,
--- Use NULL for `registry_actions.service_url`
  NULL as service_url,
--- Copy `commits.content` to `registry_actions.sdl`
  content as sdl,
  metadata,
  commit,
--- Use `N/A` for `registry_actions.action`
  'N/A'::registry_action as action,
  target_id,
  project_id
FROM public.commits;

--- Update `registry_actions.action` for something else
UPDATE public.registry_actions
SET action = 'ADD'
WHERE id IN (
  SELECT DISTINCT ON (c.service, c.target_id) c.id
  FROM public.commits c
  LEFT JOIN public.projects p ON p.id = c.project_id
  WHERE p.type = 'FEDERATION' OR p.type = 'STITCHING'
  GROUP BY (c.service, c.target_id, c.created_at, c.id)
  ORDER BY c.service, c.target_id, c.created_at ASC
);

UPDATE public.registry_actions
SET action = 'MODIFY'
WHERE 
  action = 'N/A'
  AND 
  project_id IN (
    SELECT id FROM public.projects WHERE type = 'FEDERATION' OR type = 'STITCHING'
  )
;

--- Update `registry_actions.service_url` for something else (take it from `version_commit.url`)
UPDATE public.registry_actions
SET service_url = (
  SELECT vc.url FROM public.version_commit vc
  LEFT JOIN public.versions v ON v.id = vc.version_id
  WHERE vc.commit_id = registry_actions.id
  ORDER BY v.created_at DESC LIMIT 1
);

-- 2. Copy `versions` to `registry_versions`
INSERT INTO public.registry_versions (
  id,
  created_at,
  is_composable,
  base_schema,
  target_id,
  action_id
) SELECT
  id,
  created_at,
  valid as is_composable,
  base_schema,
  target_id,
  commit_id as action_id
FROM public.versions;


-- 3. Copy `version_commit` to `registry_version_action`
INSERT INTO public.registry_version_action (
  version_id,
  action_id
) SELECT
  version_id,
  commit_id as action_id
FROM public.version_commit;
