alter table research_analyses add column if not exists flags_na text[] not null default '{}';
