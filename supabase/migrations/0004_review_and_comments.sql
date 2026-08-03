create table public.review_sessions (
  review_session_id  uuid primary key default gen_random_uuid(),
  whiteboard_id      uuid not null references public.whiteboards (whiteboard_id) on delete cascade,
  round_no           smallint not null,
  source_revision_no integer not null,
  source_canvas_json jsonb not null,
  source_canvas_hash char(64) not null,
  status             text not null default 'queued',
  requested_by       uuid not null references auth.users (id),
  model_name         text not null default 'gpt-5.5',
  reasoning_effort   text not null default 'high',
  review_summary_json jsonb not null default '{}'::jsonb,
  error_json         jsonb,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz,
  constraint uq_review_sessions_board_round unique (whiteboard_id, round_no),
  constraint uq_review_sessions_id_board unique (review_session_id, whiteboard_id),
  constraint ck_review_sessions_round_positive check (round_no > 0),
  constraint ck_review_sessions_revision_positive check (source_revision_no > 0),
  constraint ck_review_sessions_status check (status in ('queued','running','completed','failed')),
  constraint ck_review_sessions_hash_format check (meridian.is_sha256_hex(source_canvas_hash)),
  constraint ck_review_sessions_snapshot_object check (meridian.is_json_object(source_canvas_json)),
  constraint ck_review_sessions_summary_object check (meridian.is_json_object(review_summary_json)),
  constraint ck_review_sessions_effort check (reasoning_effort in ('low','medium','high','n/a')),
  constraint ck_review_sessions_terminal_completed_at
    check ((status in ('completed','failed')) = (completed_at is not null)),
  constraint ck_review_sessions_failed_has_error
    check (status <> 'failed' or error_json is not null)
);

create index ix_review_sessions_board_created on public.review_sessions (whiteboard_id, created_at desc);
create unique index uq_review_sessions_active
  on public.review_sessions (whiteboard_id) where status in ('queued','running');

create table public.comments (
  comment_id           uuid primary key default gen_random_uuid(),
  whiteboard_id        uuid not null references public.whiteboards (whiteboard_id) on delete cascade,
  review_session_id    uuid not null,
  thread_id            uuid not null,
  parent_comment_id    uuid,
  author_type          text not null,
  author_user_id       uuid references auth.users (id),
  body                 text not null,
  anchor_type          text not null,
  anchor_id            uuid,
  anchor_field_path    text,
  status               text,
  severity             text,
  issue_key            text,
  suggested_patch_json jsonb,
  metadata_json        jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  resolved_at          timestamptz,
  constraint uq_comments_id_board  unique (comment_id, whiteboard_id),
  constraint uq_comments_id_thread unique (comment_id, thread_id),
  constraint ck_comments_author_type check (author_type in ('ai','user','system')),
  constraint ck_comments_anchor_type check (anchor_type in ('node','edge','canvas')),
  constraint ck_comments_body_nonempty check (length(btrim(body)) > 0),
  constraint ck_comments_status check (status is null or status in ('open','answered','rejected','resolved')),
  constraint ck_comments_severity check (severity is null or severity in ('blocking','non_blocking')),
  constraint ck_comments_root_requires_status check ((parent_comment_id is null) = (status is not null)),
  constraint ck_comments_root_requires_severity check ((parent_comment_id is null) = (severity is not null)),
  constraint ck_comments_root_requires_issue_key check ((parent_comment_id is null) = (issue_key is not null)),
  constraint ck_comments_issue_key_shape check (issue_key is null or issue_key ~ '^(det|mod|gap):[a-z0-9_:.\-]+$'),
  constraint ck_comments_root_thread_identity check (parent_comment_id is not null or thread_id = comment_id),
  constraint ck_comments_not_self_parent check (parent_comment_id is null or parent_comment_id <> comment_id),
  constraint ck_comments_user_author check (
    (author_type = 'user' and author_user_id is not null) or
    (author_type in ('ai','system') and author_user_id is null)),
  constraint ck_comments_anchor_pairing check (
    (anchor_type = 'canvas' and anchor_id is null) or
    (anchor_type in ('node','edge') and anchor_id is not null)),
  constraint ck_comments_resolved_at check ((status = 'resolved') = (resolved_at is not null)),
  constraint ck_comments_metadata_object check (meridian.is_json_object(metadata_json)),
  constraint ck_comments_metadata_kind check (
    metadata_json ? 'kind' and
    metadata_json->>'kind' in ('review_issue','reply','rejection','graph_patch','assumption','policy_gap')),
  constraint ck_comments_metadata_shape check (
    case metadata_json->>'kind'
      when 'review_issue' then metadata_json ? 'issueKey' and metadata_json ? 'origin'
                               and metadata_json->>'origin' in ('deterministic','model')
      when 'rejection'    then metadata_json ? 'reason' and length(btrim(metadata_json->>'reason')) > 0
      when 'graph_patch'  then metadata_json ? 'patchVersion' and metadata_json ? 'appliedRevisionNo'
      when 'assumption'   then metadata_json ? 'assumptionText' and metadata_json ? 'sourceRootCommentId'
      when 'policy_gap'   then metadata_json ? 'evalRunId' and metadata_json ? 'failureKey'
                               and metadata_json ? 'agentVersionId'
      else true
    end),
  constraint ck_comments_patch_object
    check (suggested_patch_json is null or meridian.is_json_object(suggested_patch_json)),
  constraint fk_comments_session_board
    foreign key (review_session_id, whiteboard_id)
    references public.review_sessions (review_session_id, whiteboard_id) on delete cascade,
  constraint fk_comments_parent_board
    foreign key (parent_comment_id, whiteboard_id)
    references public.comments (comment_id, whiteboard_id) on delete cascade,
  constraint fk_comments_parent_thread
    foreign key (parent_comment_id, thread_id)
    references public.comments (comment_id, thread_id) on delete cascade
);

create index ix_comments_thread on public.comments (whiteboard_id, thread_id, created_at);
create index ix_comments_root_status on public.comments (whiteboard_id, status) where parent_comment_id is null;
create index ix_comments_issue_key on public.comments (whiteboard_id, issue_key);
create index ix_comments_kind on public.comments (whiteboard_id, (metadata_json->>'kind'));
create unique index uq_comments_session_issue
  on public.comments (review_session_id, issue_key) where parent_comment_id is null;
create unique index uq_comments_live_issue
  on public.comments (whiteboard_id, issue_key)
  where parent_comment_id is null and status in ('open','answered');
create unique index uq_comments_assumption_per_root
  on public.comments ((metadata_json->>'sourceRootCommentId'))
  where metadata_json->>'kind' = 'assumption' and metadata_json->>'supersedesCommentId' is null;

-- Review session snapshot immutability.
create or replace function meridian.check_review_session_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.whiteboard_id <> old.whiteboard_id
     or new.round_no <> old.round_no
     or new.source_revision_no <> old.source_revision_no
     or new.source_canvas_json <> old.source_canvas_json
     or new.source_canvas_hash <> old.source_canvas_hash
     or new.requested_by <> old.requested_by then
    raise exception 'REVIEW_SESSION_IMMUTABLE_FIELD' using errcode = 'P0001';
  end if;
  if old.status <> 'queued'
     and (new.model_name <> old.model_name or new.reasoning_effort <> old.reasoning_effort) then
    raise exception 'REVIEW_MODEL_CONFIG_FROZEN' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger tg_review_sessions_immutable before update on public.review_sessions
  for each row execute function meridian.check_review_session_immutable();
