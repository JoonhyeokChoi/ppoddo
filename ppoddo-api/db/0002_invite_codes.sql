-- ============================================================
-- 뽀또 (Ppoddo) — 0002 초대 코드 형식 + 레이트 리미팅
-- 2026-08-20
--
-- 실행: Supabase Dashboard > SQL Editor 에 붙여넣기
-- 선행: 0001_init.sql 이 이미 적용돼 있어야 한다.
--
-- 배경: 초대 코드는 조부모님이 폰으로 직접 입력한다. 이 마이그레이션은
-- 코드 형식을 6자리 숫자로 고정하고, 그 때문에 낮아진 엔트로피를 두 겹의
-- 시도 횟수 제한으로 보완한다. 엔드포인트 코드는 여기 없다 — 스키마와
-- 불변식(제약·인덱스)만 만든다. 판정 로직은 백엔드가 이 위에서 수행한다.
-- ============================================================


-- ------------------------------------------------------------
-- 0. 제자리 변경 vs 파괴적 재생성 — 제자리를 택했다
--
-- 파괴적 재생성(DROP + CREATE)도 검토했으나 제자리(ALTER)가 더 깔끔했다:
--   - 재생성을 하면 인덱스·외래 키·RLS·기존 shape 제약을 전부 다시
--     선언해야 한다. 손댈 곳이 늘어나고 0001 과 정의가 갈라진다.
--   - 제자리로 두면 기존 invite_shape / invite_used_shape 제약이 글자 그대로
--     보존된다. "기존 shape 제약이 그대로 동작한다"는 요구를 가장 강하게
--     보장하는 방법은 그것들을 아예 건드리지 않는 것이다.
--   - invite_codes 의 RLS 도 0001 에서 켠 상태 그대로 유지된다.
--
-- 단 하나 필요한 파괴적 동작은 기존 테스트 행을 비우는 것이다. 새 형식
-- CHECK 는 6자리 숫자가 아닌 기존 행을 거부하므로, 제약을 추가하기 전에
-- 반드시 테이블을 비워야 한다. 지금 DB 에는 내 테스트 데이터밖에 없으므로
-- 안전하다. 운영 데이터가 생긴 뒤였다면 이 TRUNCATE 는 불가했을 것이다.
-- ------------------------------------------------------------

-- 형식에 맞지 않는 기존 테스트 행 제거. 비어 있으면 무해한 no-op 이고,
-- 남아 있으면 아래 ADD CONSTRAINT 가 통과하기 위해 반드시 필요하다.
truncate public.invite_codes;


-- ------------------------------------------------------------
-- 1. invite_codes — 코드별 실패 카운터 + 형식 고정
-- ------------------------------------------------------------

-- 코드별 실패 횟수. 5회 실패 시 코드가 죽는다(임계값은 엔드포인트가 판정).
-- boolean 이 아니라 카운터인 이유: "몇 번 남았나"를 알 수 있어야 하고,
-- 죽음 여부(>= 5)는 거기서 파생된다.
alter table public.invite_codes
  add column failed_attempts integer not null default 0;

-- 코드 형식: 6자리 숫자만.
--
-- 조부모님 입력 편의가 설계의 전부다. 영숫자 혼합은 6글자에 키보드 전환을
-- 다섯 번 강요하고, 그러고도 0/o·1/l 혼동이 남는다. 컬럼을 text 로 유지하는
-- 이유는 선행 0 보존('012345' 이 6자리 그대로여야 하므로) — 숫자 타입이면
-- 12345 로 뭉개진다.
--
-- 형식을 관례가 아니라 CHECK 로 강제하는 이유: 잘못된 코드가 애초에 들어오지
-- 못하게 하려는 것. \d 대신 [0-9] 로 쓴 건 POSIX 정규식 해석 차이를 피하려는
-- 보수적 선택.
--
-- ★ 이 형식은 조합을 1e6(백만) 으로 떨어뜨린다. 아래 두 겹의 시도 제한이
--   선택이 아니라 필수인 이유가 정확히 이것이다 — 백만은 사람이 아니라
--   자동화가 상대할 수 있는 수이고, 코드 하나하나가 아이 사진에 대한 접근권이다.
alter table public.invite_codes
  add constraint invite_code_format check (code ~ '^[0-9]{6}$');

-- 실패 카운터는 음수가 될 수 없다. 상한(5)을 CHECK 로 걸지 않는 이유:
-- 잠금 임계값에서 실패를 기록하는 순간 제약 위반이 나면 "코드가 잠겼습니다"가
-- 500 으로 둔갑한다. 상한 판정은 엔드포인트가 하고, DB 는 기록 자체를 막지
-- 않는다. (0001 이 실패 모드를 다루는 태도와 같다.)
alter table public.invite_codes
  add constraint invite_failed_attempts_nonneg check (failed_attempts >= 0);

-- 코드가 무효가 되는 세 경우는 행만 읽어도 서로 구분된다. 엔드포인트가
-- 사용자에게 서로 다른 안내를 해줄 수 있어야 하기 때문이다:
--
--   used_at is not null    → 이미 사용됨   "이미 쓴 코드예요"
--   expires_at < now()     → 만료됨        "코드가 만료됐어요, 새로 받으세요"
--   failed_attempts >= 5   → 잠김(죽음)    "코드가 잠겼어요, 새로 받으세요"
--
-- "만료"와 "잠김"은 원인이 다르니 문구도 달라야 한다 — 하나는 시간이,
-- 하나는 틀린 입력이 원인이다. 세 조건이 겹칠 때의 우선순위는 엔드포인트가
-- 정한다. create_group / join_group 두 종류 모두 여전히 1회용이며,
-- used_at/used_by 설계와 그 제약은 0001 그대로 둔다.


-- ------------------------------------------------------------
-- 2. invite_attempts — 사용자별 실패 기록 (두 번째 겹)
--
-- 코드별 카운터(1)만으로는 부족하다. 공격자가 코드를 계속 바꿔가며 찔러보면
-- 코드별 제한은 매번 새 코드라 걸리지 않는다. 그래서 사용자 단위로도 센다.
--
-- 실패만, 그리고 user_id 와 시각만 기록한다. 최근 1시간 내 개수가 임계값을
-- 넘으면 그 사용자를 잠시 차단한다.
--
-- ★ 성공했다고 행을 지우지 않는다. 지우면 공격자가 정상 코드 하나로 자기
--   실패 카운터를 리셋할 수 있다("한 번 성공시키면 과거 실패가 사라짐").
--   그래서 시간 창이 자연히 만료시키게 두고, 오래된 행은 이후 주기적 잡이
--   쓸어낸다. 시도한 코드 값 자체는 일부러 저장하지 않는다 — 지금 필요한 건
--   "누가 몇 번 실패했나"뿐이고, 필요해지면 그때 컬럼을 추가한다.
-- ------------------------------------------------------------

create table public.invite_attempts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  attempted_at timestamptz not null default now()
);

-- 실제로 서비스할 쿼리를 위한 인덱스:
--
--   select count(*) from public.invite_attempts
--    where user_id = $1 and attempted_at > now() - interval '1 hour'
--
-- (user_id 동등 + attempted_at 범위) 순서의 복합 인덱스가 이 모양을 그대로
-- 탄다 — 첫 컬럼으로 사용자를 좁히고 둘째 컬럼으로 시간 범위를 훑는다.
-- 순서가 반대(attempted_at, user_id)면 사용자 필터가 인덱스를 못 탄다.
create index on public.invite_attempts (user_id, attempted_at);


-- ------------------------------------------------------------
-- 3. RLS — 새 테이블도 켜고, 정책은 0개 (기본 거부)
--
-- invite_attempts 는 새 테이블이라 반드시 켜야 한다. invite_codes 는 제자리
-- 변경이라 0001 에서 켠 RLS 가 그대로 살아 있지만, 의도를 문서화하고 혹시
-- 모를 상태를 못 박기 위해 한 번 더 켠다(이미 켜진 것을 켜는 건 no-op).
--
-- 이유는 0001 과 동일: anon 키가 앱 번들에 들어 있어 누구나 꺼내서 Supabase
-- REST API 를 직접 호출할 수 있다. 정책 없는 RLS = 기본 거부. Cloud Run 만
-- service_role 로 접속해 RLS 를 우회하고, 인가는 백엔드가 직접 수행한다.
-- 특히 invite_attempts 가 RLS 없이 열리면 공격자가 자기 실패 기록을 직접
-- 지워 사용자별 제한을 무력화할 수 있으므로, 여기서 기본 거부는 필수다.
-- ------------------------------------------------------------

alter table public.invite_codes    enable row level security;  -- 재확인 (이미 ON)
alter table public.invite_attempts enable row level security;  -- 신규


-- ============================================================
-- 확인용 쿼리 (실행 후 손으로 돌려볼 것)
-- ============================================================

-- (1) RLS 가 두 테이블 모두 켜졌는지 — rowsecurity 가 둘 다 true 여야 한다.
--
--   select tablename, rowsecurity from pg_tables
--   where schemaname = 'public' and tablename in ('invite_codes','invite_attempts')
--   order by tablename;

-- (2) 새 제약이 다 붙었는지 — invite_code_format, invite_failed_attempts_nonneg,
--     invite_shape, invite_used_shape 가 모두 보여야 한다.
--
--   select conname, contype from pg_constraint
--   where conrelid = 'public.invite_codes'::regclass order by conname;

-- (3) 형식 CHECK 가 실제로 막는지. <your-uuid> 를 본인 UUID 로 바꿔서:
--     '123456' 은 통과해야 하고, 나머지는 23514(CHECK 위반)로 실패해야 한다.
--
--   -- 통과해야 함:
--   insert into public.invite_codes (code, kind, group_id, role, issued_by, expires_at)
--   values ('123456', 'join_group', '11111111-1111-1111-1111-111111111111',
--           'viewer', '<your-uuid>', now() + interval '7 days');
--
--   -- 각각 실패해야 함 (문자 포함 / 5자리 / 7자리):
--   --   '12ab56'  ·  '12345'  ·  '1234567'
--
--   -- 확인 후 정리:
--   -- delete from public.invite_codes where code = '123456';

-- (4) failed_attempts 기본값이 0 인지 — 위 (3) 의 통과 행을 지우기 전에:
--
--   select code, failed_attempts, expires_at from public.invite_codes;
