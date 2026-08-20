-- ============================================================
-- 뽀또 (Ppoddo) — initial schema
-- 2026-08-06
--
-- 실행: Supabase Dashboard > SQL Editor 에 붙여넣기
-- 이후 Expo 프로젝트 생성 시 supabase/migrations/ 로 이동할 것
--
-- 설계 근거는 아키텍처 문서 v1.0 참고
-- ============================================================


-- ------------------------------------------------------------
-- 1. Enum 타입
--
-- enum 은 값 추가(alter type ... add value)는 쉽지만
-- 제거·순서 변경이 까다롭다. 아래 값들은 PRD 에서 확정된 것들.
-- ------------------------------------------------------------

create type membership_role as enum ('owner', 'admin', 'contributor', 'viewer');
create type media_kind      as enum ('photo', 'video');
create type media_status    as enum ('pending', 'ready');
create type invite_kind     as enum ('join_group', 'create_group');
create type comment_target  as enum ('media', 'date');   -- 'date' 는 v1.1 대비


-- ------------------------------------------------------------
-- 2. users
--
-- id 는 auth.users(id) 를 그대로 사용한다. 새 UUID 를 만들지 않는다.
-- → JWT 의 sub 가 곧 앱의 사용자 ID 가 되어 매핑 조회가 사라진다.
--
-- 행 생성은 트리거가 아니라 백엔드가 온보딩 완료 시점에 한다.
-- → 행의 존재 자체가 "온보딩 완료" 신호가 된다. 별도 플래그 불필요.
-- → 생성 엔드포인트는 on conflict do nothing 으로 멱등하게.
-- ------------------------------------------------------------

create table public.users (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at   timestamptz not null default now()
);


-- ------------------------------------------------------------
-- 3. groups
-- ------------------------------------------------------------

create table public.groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now()
);

create index on public.groups (created_by);


-- ------------------------------------------------------------
-- 4. memberships
--
-- 복합 기본 키가 곧 중복 가입 방지 장치다. 별도 unique 제약이 필요 없다.
-- 인가 검사(where user_id = ? and group_id = ?)가 이 인덱스를 그대로 탄다.
--
-- group_id 단독 인덱스가 따로 필요한 이유 두 가지:
--   (1) "이 그룹의 멤버 목록" 조회는 복합 키 인덱스를 못 탄다
--       (인덱스가 user_id 로 먼저 정렬되어 있으므로)
--   (2) Postgres 는 외래 키에 인덱스를 자동 생성하지 않는다.
--       그룹 삭제 시 cascade 대상을 찾느라 전체 스캔 + 락이 걸린다.
-- ------------------------------------------------------------

create table public.memberships (
  user_id   uuid not null references public.users(id)  on delete cascade,
  group_id  uuid not null references public.groups(id) on delete cascade,
  role      membership_role not null,
  joined_at timestamptz not null default now(),
  primary key (user_id, group_id)
);

create index on public.memberships (group_id);


-- ------------------------------------------------------------
-- 5. media
--
-- 사진과 영상을 한 테이블에 둔다.
--   - 날짜 피드가 두 종류를 시간순으로 섞어 보여줘야 한다 (단일 쿼리)
--   - comments 가 진짜 외래 키를 걸 수 있다 (다형성 참조 회피)
--
-- 원본 존재 여부는 컬럼으로 두지 않는다. kind 가 이미 결정한다.
--   photo → original + feed 두 벌 / video → 압축본 한 벌
--
-- created_at 과 posted_on 은 서로 다른 질문에 답한다:
--   created_at : 언제 업로드됐나 (시스템 소유, 불변, UTC)
--   posted_on  : 어느 캘린더 날짜에 보이나 (사용자 소유, 수정 가능)
--
-- 3월에 찍은 사진을 8월에 올리면 8월 캘린더에 들어간다.
-- 조부모님은 캘린더를 거슬러 올라가지 않고 최근 며칠만 열어보시므로,
-- 옛날 사진을 과거 칸에 넣으면 아무도 보지 못한다.
-- 뽀또는 아카이브가 아니라 공유 채널이다 (아키텍처 문서 2.2).
--
-- 그럼에도 created_at 을 그대로 쓰지 않는 이유 두 가지:
--   1) created_at 은 UTC 라 날짜만 뽑으면 하루가 밀린다.
--      posted_on 은 백엔드가 KST 로 계산해 넣는다.
--   2) 수정 가능해야 한다. 새벽 1시에 올린 사진은 created_at 이 15일이지만
--      실제로는 14일 밤의 사진이므로 14일로 옮길 수 있어야 한다.
--
-- 촬영 시각(EXIF)은 v1 범위 밖이다. 매일 그날 사진을 올리는 것이 주 패턴이라
-- 촬영일과 게시일이 대개 같아서 표시할 것이 없다. 필요해지면 captured_at 을 추가한다.
-- ------------------------------------------------------------

create table public.media (
  id          uuid primary key default gen_random_uuid(),
  kind        media_kind not null,
  status      media_status not null default 'pending',
  posted_on   date not null,
  caption     text,
  uploaded_by uuid not null references public.users(id),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index on public.media (posted_on);
create index on public.media (uploaded_by);

-- 정리 잡(30일 경과 객체 삭제)이 쓰는 인덱스.
-- 삭제된 행만 담으므로 아주 작다.
create index on public.media (deleted_at) where deleted_at is not null;


-- ------------------------------------------------------------
-- 6. media_groups
--
-- 사진 한 장이 여러 그룹에 공유될 수 있다 (친가 + 외가).
-- 인가 판정은 이 테이블과 memberships 의 group_id 교집합으로 이뤄진다.
--
-- 구조와 인덱스 근거는 memberships 와 동일하다.
-- ------------------------------------------------------------

create table public.media_groups (
  media_id uuid not null references public.media(id)  on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  primary key (media_id, group_id)
);

create index on public.media_groups (group_id);


-- ------------------------------------------------------------
-- 7. comments
--
-- group_id 를 갖는다 — 같은 사진이라도 그룹마다 댓글이 분리된다.
-- 친할머니는 외가 그룹의 댓글을 볼 수 없다.
--
-- target_type 은 v1 에서 항상 'media' 다.
-- 'date' 는 v1.1 의 날짜 단위 댓글용.
--
-- 날짜 댓글에는 posted_on 이 반드시 있어야 한다.
-- created_at 으로 대체할 수 없다 — 그건 "댓글이 쓰인 시각"이지
-- "어느 날에 대한 댓글인가"가 아니다.
-- 6월 20일에 6월 14일 피드를 보며 단 댓글은 14일에 붙어야 한다.
-- (media 의 created_at / posted_on 분리와 같은 이유)
--
-- 두 형태가 서로 배타적이도록 제약을 건다:
--   media 댓글 → media_id 있음,  posted_on 없음
--   date  댓글 → media_id 없음,  posted_on 있음
-- ------------------------------------------------------------

create table public.comments (
  id          uuid primary key default gen_random_uuid(),
  target_type comment_target not null default 'media',
  media_id    uuid references public.media(id) on delete cascade,
  posted_on   date,
  group_id    uuid not null references public.groups(id) on delete cascade,
  author_id   uuid not null references public.users(id),
  body        text not null,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,

  constraint comments_target_shape check (
    (target_type = 'media' and media_id is not null and posted_on is null) or
    (target_type = 'date'  and media_id is null     and posted_on is not null)
  )
);

create index on public.comments (media_id, group_id);
create index on public.comments (group_id);
create index on public.comments (author_id);

-- 날짜 댓글 조회용 (v1.1). 해당 행만 담으므로 v1 에서는 비어 있다.
create index on public.comments (group_id, posted_on) where target_type = 'date';


-- ------------------------------------------------------------
-- 8. invite_codes
--
-- 1회용을 boolean 이 아니라 타임스탬프로 표현한다.
--   used_at is null → 아직 사용 안 함 (boolean 과 동일한 판정)
--   추가로 "언제, 누가" 썼는지가 남는다.
--
-- 이건 시안이 사진에 접근할 수 있는 사람이 어떻게 늘어났는지의 기록이다.
-- 사용된 코드는 삭제하지 말고 남겨둘 것.
--
-- role 은 join_group 코드에만 의미가 있다 (코드에 역할이 박혀 있음).
-- ------------------------------------------------------------

create table public.invite_codes (
  code       text primary key,
  kind       invite_kind not null,
  group_id   uuid references public.groups(id) on delete cascade,
  role       membership_role,
  issued_by  uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz,
  used_by    uuid references public.users(id),

  -- join_group 은 대상 그룹과 역할이 반드시 있어야 하고,
  -- create_group 은 둘 다 없어야 한다.
  constraint invite_shape check (
    (kind = 'join_group'   and group_id is not null and role is not null) or
    (kind = 'create_group' and group_id is null     and role is null)
  ),

  -- 사용 여부는 두 컬럼이 함께 움직인다
  constraint invite_used_shape check (
    (used_at is null and used_by is null) or
    (used_at is not null and used_by is not null)
  )
);

create index on public.invite_codes (group_id);
create index on public.invite_codes (issued_by);


-- ------------------------------------------------------------
-- 9. RLS — 전부 켜고, 정책은 만들지 않는다
--
-- anon key 는 앱 번들에 들어가므로 누구나 꺼내서
-- Supabase REST API 를 직접 호출할 수 있다. Cloud Run 을 우회해서.
--
-- RLS 가 꺼진 테이블은 그 키만으로 전부 읽힌다.
-- 정책 없이 RLS 만 켜면 = 기본 거부. anon/authenticated 로는 아무것도 안 된다.
--
-- Cloud Run 은 service_role 로 접속하므로 RLS 를 우회한다.
-- 인가는 백엔드가 memberships 조회로 직접 수행한다 (아키텍처 문서 3.4).
--
-- 앱은 Supabase 를 로그인에만 쓰고, 데이터는 전부 Cloud Run 을 거친다.
-- ------------------------------------------------------------

alter table public.users        enable row level security;
alter table public.groups       enable row level security;
alter table public.memberships  enable row level security;
alter table public.media        enable row level security;
alter table public.media_groups enable row level security;
alter table public.comments     enable row level security;
alter table public.invite_codes enable row level security;


-- ------------------------------------------------------------
-- 확인용 쿼리
--
-- RLS 가 모든 테이블에 켜졌는지 검증:
--
  -- select tablename, rowsecurity
  -- from pg_tables
  -- where schemaname = 'public'
  -- order by tablename;
--
-- rowsecurity 가 전부 true 여야 한다.
-- ------------------------------------------------------------