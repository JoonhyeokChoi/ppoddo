# 뽀또 개발 노트

대화 중 정리한 내용을 모아둔 파일.
설계 결정은 CLAUDE.md, 진행 상황은 ROADMAP 체크리스트, 배우거나 겪은 것은 여기.

---

# Phase 0 — 인프라

## GCS 버킷 (2026-08-05 완료)

```
name: ppoddo / asia-northeast3 (Seoul) / Standard
uniform access · public access prevention ON
soft delete 7d · versioning OFF · hierarchical namespace OFF
```

**같은 버킷을 CLI로 만들 때**

```bash
gcloud storage buckets create gs://ppoddo \
  --project=ppoddo-504520 \
  --location=asia-northeast3 \
  --default-storage-class=STANDARD \
  --uniform-bucket-level-access \
  --public-access-prevention \
  --soft-delete-duration=7d

gcloud storage buckets describe gs://ppoddo    # 설정 확인
gcloud storage buckets create --help           # 플래그는 gcloud 버전마다 다를 수 있음
```

**설정별 이유**

| 설정 | 이유 |
|---|---|
| uniform access | 세분화(ACL)를 쓸 이유가 없음. 애초에 버킷에 접근하는 주체는 서비스 계정 하나뿐이고, 가족들은 GCP 신원 자체가 없음. 안 쓰는 ACL 기능이 켜져 있으면 실수할 지점만 늘어남 |
| public access prevention | 이 버킷은 절대 공개될 일 없음. 켜두면 나중에 실수로도 못 바꿈 |
| versioning OFF | 덮어쓰기 방지용인데, 경로가 매번 새 UUID라 덮어쓸 일이 없음 |
| soft delete 7d | 30일 소프트 삭제(Postgres)와는 다른 위험을 막음. `deleted_at`은 "사용자가 실수로 지운 것", GCS soft delete는 "내 정리 잡 코드가 잘못 지운 것"을 막음 |
| HNS OFF | 폴더 이름 변경을 원자적으로 해주는 기능인데, 우리 설계는 경로가 불변이라 필요 없음. **생성 후 변경 불가** |
| retention OFF | 켜면 객체를 기간 만료 전까지 삭제 불가 → 30일 정리 잡이 깨짐 |

**균일한 액세스는 90일 뒤 영구 확정됨.** 우리 설계엔 세분화로 돌아갈 일이 없으니 오히려 잘된 것.

**콘솔에서 이미 보이던 것**: `Editors of project` 에 Storage Legacy 역할이 이미 붙어 있음.
프로젝트 수준 바인딩이 버킷으로 상속된 것. 즉 프로젝트 Editor 를 가진 주체는 이미 이 버킷에
접근 가능 → Compute Engine 기본 서비스 계정이 그 Editor 를 가짐 → **전용 서비스 계정이 필요한 이유**

---

## IAM — 커스텀 역할과 서비스 계정 (2026-08-06 완료)

```bash
gcloud iam roles create ppoddo_storage_access \
  --project=ppoddo-504520 \
  --title="Ppoddo Storage Access" \
  --permissions=storage.objects.create,storage.objects.get,storage.objects.delete \
  --stage=GA

gcloud iam service-accounts create ppoddo-backend \
  --display-name="Ppoddo Cloud Run backend"

gcloud storage buckets add-iam-policy-binding gs://ppoddo \
  --member=serviceAccount:ppoddo-backend@ppoddo-504520.iam.gserviceaccount.com \
  --role=projects/ppoddo-504520/roles/ppoddo_storage_access
```

**이름 규칙 주의**: 역할 ID 는 하이픈 불가(밑줄 사용), 서비스 계정 이름은 밑줄 불가(하이픈 사용). 반대임.

**권한을 세 개로 정한 과정**

필요한 동작을 먼저 나열하고 거기에 맞는 권한을 찾음. 순서가 반대면("일단 넓게 주고 나중에 줄이자") 절대 안 줄어듦.

| 흐름 | 필요 권한 |
|---|---|
| 업로드 | `storage.objects.create` |
| 조회 | `storage.objects.get` |
| 30일 정리 잡 | `storage.objects.delete` |

**`list` 를 뺀 이유**: Postgres 가 인덱스이고 GCS 는 그냥 저장소. 백엔드는 항상 정확한 경로를 이미 알고 있음.
나중에 어떤 코드가 `list` 를 원하면, 그건 GCS 를 진실의 원천처럼 쓰고 있다는 신호 → 권한을 추가할 게 아니라 설계를 고칠 것.

**중요한 함정**: 백엔드는 파일을 직접 올리지 않는데도 `create` 권한이 필요함.
**서명 URL 은 서명자가 갖지 않은 권한을 부여할 수 없기 때문.** 앱이 그 URL 로 PUT 하면
GCS 는 "이 URL 을 서명한 계정이 객체를 만들 수 있나"를 확인함. 없으면 403.
→ 권한이 필요한 이유가 "직접 하려고"가 아니라 "위임하려고"

**커스텀 역할 vs 기본 역할**: create/get/delete 를 다 포함하는 기본 역할은 전부 `list` 를 같이 가져옴.
커스텀 역할은 자동 갱신되지 않는데, 이건 오히려 장점 — 구글이 기본 역할에 권한을 추가해도 우리 역할은 조용히 넓어지지 않음.

**바인딩은 프로젝트가 아니라 버킷 수준에.** 나중에 `ppoddo-test` 같은 버킷을 만들어도 자동으로 접근되지 않음.

---

## GCP IAM 의 방향 (헷갈리기 쉬운 부분)

**"서비스 계정에 역할을 붙인다"가 아님. 정책은 리소스에 붙고, 그 정책이 주체를 지목함.**

```bash
gcloud storage buckets add-iam-policy-binding gs://ppoddo \   # ← 주어는 버킷(리소스)
  --member=serviceAccount:...                                 # ← 누구에게
  --role=...                                                  # ← 어떤 역할을
```

AWS IAM 은 정책을 신원에 붙이지만 GCP 는 리소스에 붙임.
콘솔에서도 `Grant access` 버튼이 **버킷 페이지에** 있는 게 그 증거.

**추가 혼란 지점**: 서비스 계정 자체도 리소스임. 그래서 서비스 계정 *위에* 정책을 걸 수도 있음.
→ 서비스 계정은 **주체이면서 동시에 리소스**

---

## 키 없는 서명 (signBlob)

서명 URL 을 만들려면 개인키로 서명해야 함. 보통은 서비스 계정 JSON 키를 받아서 쓰는데,
그 순간 **만료도 범위 제한도 없는 비밀**이 생김. 유출되면 무기한 유효.

**대안**: IAM Credentials API 의 `signBlob` 에 서명을 위임. 개인키는 구글이 갖고 있고 우리는 보지 않음.
→ **관리할 키 파일이 존재하지 않음. 최고의 비밀 관리는 비밀을 안 만드는 것.**

```bash
gcloud services enable iamcredentials.googleapis.com

# 리소스도 ppoddo-backend, 주체도 ppoddo-backend (자기 자신 가장)
gcloud iam service-accounts add-iam-policy-binding \
  ppoddo-backend@ppoddo-504520.iam.gserviceaccount.com \
  --member=serviceAccount:ppoddo-backend@ppoddo-504520.iam.gserviceaccount.com \
  --role=roles/iam.serviceAccountTokenCreator
```

**→ Secret Manager 에 키를 저장하는 로드맵 항목이 사라짐 (저장할 키가 없음)**

### 가장(impersonation)이 로컬에서 필요한 이유

준 개인 계정으로 테스트하면 안 되는 이유가 둘:

1. **서명 URL 은 서비스 계정만 만들 수 있음.** 개인 구글 계정에는 서명에 쓸 신원이 없어서,
   소유자 권한이 있어도 `getSignedUrl` 이 실패함. 키 파일을 받거나 가장하거나 둘 중 하나.
2. **프로덕션과 같은 권한 범위에서 시험하려고.** 소유자 권한이 모든 걸 덮으면
   통과해도 Cloud Run 에서 되는지 알 수 없음.

**가장 = 내 권한을 더하는 게 아니라 내려놓고 서비스 계정 권한만 쓰는 것.**
단 가장을 *요청하는* 순간에는 내 권한이 쓰임 (tokenCreator 확인 단계).

| | 키 파일 | 가장 |
|---|---|---|
| 만료 | 없음 (영구) | 1시간 |
| 형태 | 디스크의 파일 | 메모리의 임시 토큰 |
| 유출되면 | 무기한 사용 가능 | 곧 만료 |
| 회수 | 키 폐기 필요 | IAM 바인딩 제거로 즉시 |

**Cloud Run 에서는 가장이 불필요** — 인스턴스가 그 서비스 계정 자체로 실행됨.

---

## 자격 증명이 두 벌이라는 점 ★ 계속 헷갈릴 지점

| | 쓰는 곳 | `gcloud config list` 에 |
|---|---|---|
| gcloud CLI 자격 증명 | gcloud 명령 자체 | 표시됨 |
| ADC | 라이브러리, 일부 gcloud 내부 | **안 나옴** |

`gcloud auth application-default login --impersonate-service-account` 은 **ADC 만** 바꿈.
→ 가장을 ADC 전역에 걸어두면 배포 등 일반 작업이 막히는데, `gcloud config list` 는 깨끗해 보임

**결론: 가장은 전역 설정이 아니라 스크립트 안에서 코드로 지정할 것.**

확인:
```bash
cat ~/.config/gcloud/application_default_credentials.json | head -3
# "type": "authorized_user"           → 정상
# "type": "impersonated_service_account" → 전역 가장 걸린 상태
```

또 하나: `gcloud auth application-default login --impersonate-service-account` 은
**권한을 확인하지 않고 설정만 씀.** 명령은 성공하는데 실제로는 동작하지 않음.
증상: `Permission 'iam.serviceAccounts.signBlob' denied`

---

## Supabase + OAuth

### OAuth 가 푸는 문제

승희의 구글 비밀번호를 뽀또가 절대 보지 않으면서 "이 사람이 누구인지"만 확인받는 것.
비밀번호는 구글에게만, 뽀또는 신원만 전달받음.

### 설정 값의 의미

```
client_id     : 공개 값. 구글이 "어느 앱의 요청인지" 식별
client_secret : 그 앱이 맞다는 증거. 서버 간 통신에서만 사용, 브라우저 통과 X
redirect URI  : 인가 코드를 받을 주소. 사전 등록된 곳으로만 전송
                → 없으면 공격자가 client_id 로 요청하고 코드를 자기 서버로 빼돌릴 수 있음
                → 주소 하나만 틀려도 구글이 거부하는 이유
```

### 흐름 (Authorization Code Flow)

```
1. 앱/브라우저 → 구글 : 로그인 요청 (client_id 포함)
2. 구글            : 승희가 비밀번호 입력 + 동의
3. 구글 → Supabase : 인가 코드 (등록된 주소로만)
4. Supabase → 구글 : 코드 + client_secret 교환   ← 서버 간 직접
5. 구글 → Supabase : ID 토큰 / 사용자 정보
6. Supabase → 앱   : Supabase JWT
```

**왜 코드/토큰 2단계인가**: 3번은 브라우저를 통과해 주소창·로그에 남음 → 진짜 토큰을 싣지 않음.
1회용 단기 코드만 보내고, 실제 교환은 secret 이 필요한 서버 간 통신(4번)에서.
코드를 훔쳐도 secret 이 없으면 토큰으로 못 바꿈.

**핵심: OAuth 클라이언트는 뽀또 앱이 아니라 Supabase**
- redirect URI 가 Supabase 콜백 주소이고 secret 도 Supabase 가 보관
- 6번 이후 앱과 Cloud Run 은 Supabase JWT 하나만 사용
- 애플 로그인을 추가해도 왼쪽 절반만 바뀜. Cloud Run 코드는 그대로

### 구글 설정

```
1. APIs & Services → OAuth 동의 화면 → External, 앱 이름 + 지원 이메일
2. 사용자 인증 정보 → OAuth 클라이언트 ID → 웹 애플리케이션
3. 승인된 리디렉션 URI: https://<project-ref>.supabase.co/auth/v1/callback
4. 클라이언트 ID / 보안 비밀 → Supabase > Authentication > Providers > Google
```

브라우저에서 바로 확인 가능:
`https://<project-ref>.supabase.co/auth/v1/authorize?provider=google`

### 카카오 — 막힘 (2026-08-06)

```
에러: Invalid Request (KOE205)
Unset consent item(s): account_email, profile_image
```

**원인**: Supabase 가 카카오 로그인 시 `account_email` 을 기본으로 요청함.
일반 개발자 계정은 그 동의항목을 켤 수 없음(비즈 앱 전환 필요).

- `profile_image` : 동의항목에서 바로 설정 가능
- `account_email` : 비즈 앱 전환 필요 → 불가

**시도한 것**: `?provider=kakao&scopes=profile_nickname` 으로 scope 지정 → **무시됨, 여전히 KOE205**

**"Allow users without an email" 토글로는 해결 안 됨** — 두 설정이 다른 시점을 다룸
- 토글 = 카카오가 이메일을 안 줬을 때의 **응답 처리**
- KOE205 = 애초에 account_email 을 **요청**한 것

**결정**: 카카오는 Phase 6(네이티브 SDK 전환 시점)으로 이동. Phase 1~2 는 구글만으로.
어차피 네이티브 경로는 OIDC(`openid` scope)를 쓰므로 웹 OAuth 맞추는 노력이 대부분 버려짐.

**Phase 6 에서 확인할 것**: 네이티브 SDK 에서도 이메일 요구가 있는지 미검증.
있다면 비즈 앱 전환 필요 → 심사 시간이 걸리므로 미리 신청해두는 것도 방법 (Apple Developer 등록과 같은 이유).

### 리전 사고 (2026-08-10)

Supabase 프로젝트가 **뭄바이(ap-south-1)** 에 생성돼 있었음. pooler 호스트명에서 발견.
`aws-0-ap-south-1.pooler.supabase.com` ← 여기서 알아챔

**Supabase 는 프로젝트 리전을 나중에 바꿀 수 없음.** 새 프로젝트를 만들어 이전해야 함.
DB 에 스키마밖에 없던 시점이라 `0001_init.sql` 재실행으로 끝남.

새 프로젝트 이전 시 같이 해야 하는 것:
1. `0001_init.sql` 재실행 + RLS 확인 쿼리
2. Google 프로바이더 재설정 (client ID/secret 은 그대로)
3. **Google Cloud 콘솔에 새 콜백 URI 추가** ← 빼먹기 쉬움. ref 가 바뀌므로
4. URL Configuration → Redirect URLs 에 앱 딥링크(`ppoddo://`) 재등록
5. "Allow users without email" 다시 켜기

---

# Phase 1 — 수직 슬라이스

## Node / 런타임 / 컨테이너

**런타임** = 코드(글자)를 실제로 실행해주는 프로그램. 악보와 연주자의 관계.

자바스크립트는 원래 브라우저 안에서만 돌았음 (파일 읽기·포트 열기 불가).
**Node** = 크롬의 JS 엔진(V8)을 떼어내 운영체제 기능(파일·네트워크·프로세스)을 붙인 것.

| | 엔진 | 그 위에 얹힌 것 |
|---|---|---|
| 브라우저 | V8 | DOM, window, document |
| Node | V8 | fs, http, net, process |
| React Native | **Hermes** | 네이티브 뷰 바인딩, fetch, RN 모듈 |

**React Native 는 런타임이 아니라 프레임워크.** 엔진은 Hermes.

→ **`@google-cloud/storage` 는 앱에서 못 돌아감.** 보안 때문만이 아니라 기술적으로 불가능.
Node 의 `crypto`, `stream`, `fs` 에 의존하는데 Hermes 에는 그게 없음.
**npm 패키지가 Node 내장 모듈에 의존하면 RN 에서 안 돌아감** — 라이브러리 고를 때 확인할 것.

**설치 필요한가**: 로컬에는 이미 있음. Cloud Run 배포 시에는 구글 서버에서 빌드하므로 내 Node 를 쓰지 않음.

### package.json

```json
"scripts": { "start": "node index.js" }   // buildpack 이 이걸 읽고 실행 명령 결정
"type": "module"                           // import 문법 사용 선언
```

### 컨테이너와 이미지

코드만으로는 못 돌아감. Node 도, 라이브러리도, 리눅스 일부 기능도 필요.

- **이미지** = 밀키트. 재료가 손질돼 담긴 완성품, 저장된 상태
- **컨테이너** = 그 밀키트를 실제로 데워 먹는 상태 (실행 중)

**왜 필요한가**: "내 컴퓨터에서는 되는데" 를 없애기 위해.
내 맥북은 Node 20, 서버는 Node 18 이면 동작이 달라질 수 있음. 이미지 안에 Node 까지 넣으면 그 차이가 사라짐.

---

## Cloud Run 배포 (2026-08-07 완료)

```bash
gcloud run deploy ppoddo-api \
  --source . \
  --region=asia-northeast3 \
  --service-account=ppoddo-backend@ppoddo-504520.iam.gserviceaccount.com \
  --allow-unauthenticated
```

| 플래그 | 이유 |
|---|---|
| `--source .` | 로컬 폴더를 업로드해 Cloud Build 가 빌드. Dockerfile·로컬 Docker·GitHub 전부 불필요 |
| `--region` | 버킷·Supabase 와 같은 서울 |
| `--service-account` | **필수.** 빼면 Compute Engine 기본 계정(프로젝트 Editor)으로 실행됨 → 권한 하나까지 따진 게 무의미해짐 |
| `--allow-unauthenticated` | 앱이 직접 호출하므로 필요. 인증은 우리가 JWT 로 직접 수행 |

**배포 흐름**
```
로컬 폴더 → Cloud Build(구글 서버) → 이미지 저장소 → Cloud Run 이 컨테이너로 실행 → URL 발급
```

**첫 배포 실패 1위**: `process.env.PORT` 를 안 쓰고 포트를 하드코딩.
컨테이너는 뜨는데 Cloud Run 이 요청을 못 보냄 → "컨테이너가 포트에서 대기하지 못했다"

**로컬 확인 먼저**: `npm start` → `http://localhost:8080` → 정상이면 배포 (종료는 Ctrl+C)

### 겪은 문제: 오래된 gcloud SDK

```
ERROR: (gcloud.run.deploy) Unable to read the runtimes experiment config
[gs://gcp-runtime-experiments/experiments.yaml]
HTTPError 403: The billing account for the owning project is disabled in state absent
```

메시지는 결제를 가리키지만 결제 문제가 아니었음. 확인한 것 전부 정상:
`gcloud config get-value project` / `gcloud billing projects describe` / `gcloud config list`

**해결: `gcloud components update`**
→ 막힐 때 초반에 시도할 값싼 수단. 에러 메시지가 원인을 잘못 가리킬 수 있음.

**GitHub 연결(CD)은 나중에.** 첫 배포에 실패 지점을 늘릴 필요 없음. 서비스가 먼저, CD 는 그다음.

---

## 서명 URL 의 원리

### URL 구조

```
X-Goog-Algorithm    GOOG4-RSA-SHA256        서명 방식
X-Goog-Credential   ppoddo-backend@... /... 누가 서명했나 + 유효 범위
X-Goog-Date         20260807T113324Z        서명 시각 (UTC)
X-Goog-Expires      900                     15분
X-Goog-SignedHeaders content-type;host      어떤 헤더가 서명에 포함됐나
X-Goog-Signature    24dd9e...               서명 결과
```

**서명 대상은 URL 전체가 아니라, 요청을 정해진 규칙으로 재구성한 문자열(CanonicalRequest).**
거기에 HTTP 메서드 + 객체 경로 + 쿼리 파라미터 + SignedHeaders 에 나열된 헤더의 **실제 값** 이 다 들어감.

### GCS 가 판단하는 순서

```
1. X-Goog-Credential 을 읽어 → 그 서비스 계정의 공개키를 가져옴
2. 들어온 요청으로 같은 문자열을 다시 조립
3. 공개키로 서명 검증 → 2번 문자열과 맞는가
4. X-Goog-Date + 900초가 지났나
5. 그 서비스 계정이 지금 이 객체에 이 작업을 할 IAM 권한이 있나
```

**양쪽이 독립적으로 같은 문자열을 만들어 대조하는 구조.**

### 서명과 검증 (암호학)

**해시(SHA-256)**: 아무리 긴 글이든 고정 길이 지문으로. 한 글자만 달라도 지문이 완전히 달라짐. 되돌릴 수 없음.

**키 쌍**: 개인키는 서명을 **만들 수** 있고, 공개키는 **확인만** 할 수 있음.
공개키로는 서명을 만들 수 없다는 **비대칭성**이 전부.

```
서명 (발급 시점, 구글 내부)        검증 (요청 시점, GCS)
요청 정보를 규칙대로 조립     →     들어온 요청으로 같은 규칙으로 재조립
SHA-256 → 지문 A                   SHA-256 → 지문 B
개인키로 지문 A 에 서명       →     공개키로 서명을 열어 지문 A 를 꺼냄
   (URL 에 실려 감)                지문 A = 지문 B 인가?
```

**위조가 안 되는 이유**
- 요청을 바꾸면 → 지문 B 가 달라짐 → 불일치. 서명도 같이 고치려면 개인키가 필요한데 없음
- 서명을 직접 만들려면 → 개인키가 필요. 공개키로는 확인만 되고 생성은 안 됨

**"암호화"와는 목적이 반대**

| | 암호화 | 서명 |
|---|---|---|
| 목적 | 내용을 숨기려고 | 출처를 증명하려고 |
| 키 사용 | 공개키로 잠그고 개인키로 엶 | 개인키로 만들고 공개키로 확인 |
| 대상 | 비밀이어야 함 | 비밀이 아님 |

지문은 애초에 비밀이 아님(요청 내용은 URL 에 다 보임).
증명하는 건 **"이 지문에 대해 유효한 값을 만들 수 있었다"는 사실 자체.**

> 참고: "복호화해서 비교" 모델은 PKCS#1 v1.5 에서는 정확하지만, RSA-PSS 같은 방식은
> 지문을 꺼내지 않고 다른 방법으로 검증함. 안전한 일반화는
> **"이 서명이 이 지문과 이 공개키에 대해 유효한가를 판정하는 것"**

### GCS 는 요청자가 아니라 서명자의 권한을 봄

폰은 아무 권한도 없음. GCS 는 요청자가 누구인지 알지도 못함.
`X-Goog-Credential` 로 **어느 공개키로 검증할지** + **누구의 IAM 권한을 볼지** 를 결정.

→ **비상 수단**: 서비스 계정의 역할 바인딩을 제거하면 이미 발급된 모든 서명 URL 이 즉시 죽음
(서명은 여전히 유효하지만 5번 검사에서 걸림). 앱 전체가 멈추는 무딘 도구지만, 유출 시 15분을 기다리는 것 말고 선택지가 있다는 뜻.

### 검증 결과

**로컬 (2026-08-06)** — 6단계 전부 통과
```
auth client class : Impersonated
has private_key   : no
signing path      : IAM signBlob
```

**Cloud Run (2026-08-07)** — 6단계 전부 통과
```
auth client class : Compute          ← 메타데이터 서버. 로컬과 다른 경로
has private_key   : no
```

경로를 한 글자 바꾼 음성 테스트 → 403. **서명이 경로를 실제로 보호함이 확인됨.**

---

## RN → GCS 직접 업로드 (2026-08-07)

**iOS / Android 결과 동일 → 플랫폼 분기 불필요**

| 방식 | 결과 |
|---|---|
| `FileSystem.uploadAsync` (PUT, BINARY_CONTENT) | **200** — 2.8MB / 747ms |
| `fetch + Blob` | 403 SignatureDoesNotMatch |

**fetch + Blob 이 실패한 이유**: content-type 을 빈 값으로 보냄.
403 본문의 CanonicalRequest 에 `content-type:` 이 비어 있는 게 그대로 보였음.
URL 은 `image/jpeg` 로 서명됐으므로 조립 문자열이 달라짐.

**→ uploadAsync 채택.** 파일 전체를 메모리에 올리지 않아 영상에도 유리.

### ★ GCS 403 디버깅 요령

**403 응답 본문에 GCS 가 계산한 `<CanonicalRequest>` 가 들어 있음.**
서명할 때 쓴 값과 한 줄씩 대조하면 어긋난 지점이 바로 보임. 추측할 필요 없음.

403 이 나는 서로 다른 원인들:
- URL 만료 (15분)
- Content-Type 불일치 ← 가장 헤매기 쉬움. 권한 문제처럼 보임
- 경로/메서드 불일치
- IAM 권한 없음

**서명 URL 은 하드코딩해도 동작함** — URL 자체가 자격 증명이므로.
폰은 GCP 신원이 없어도 됨. 프로덕션과 GCS 입장에서 완전히 같은 요청.
차이는 URL 을 어떻게 손에 넣느냐 하나뿐.

---

## Cloud Run → Supabase 연결

### Secret Manager

```bash
printf '%s' '<연결문자열>' \
  | gcloud secrets create ppoddo-db-url \
      --replication-policy=user-managed \
      --locations=asia-northeast3 \
      --data-file=-

gcloud secrets add-iam-policy-binding ppoddo-db-url \
  --member=serviceAccount:ppoddo-backend@ppoddo-504520.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor

gcloud run deploy ... --set-secrets=DATABASE_URL=ppoddo-db-url:latest
```

`printf | gcloud` 로 파이프 → 비밀번호가 셸 히스토리에 안 남음.
비밀번호에 `@ : / ? # %` 가 있으면 URL 인코딩 필요.

**왜 `--set-env-vars` 가 아니라 `--set-secrets` 인가**

env var 로 넣으면 비밀번호가 평문으로 영구히 남는 곳: 셸 히스토리, 콘솔 서비스 설정 화면,
`gcloud run services describe` 출력, 배포 로그, 프로젝트 Viewer 권한자 전원.
리비전마다 설정이 보존되므로 과거 리비전에도 남음.

시크릿이면 배포 명령에 **이름만** 나감. 비밀번호 교체 시 새 버전만 추가하면 `:latest` 가 다음 리비전에서 집음.

**GCS 와의 대비**: GCS 는 signBlob 으로 비밀 자체를 없앴지만, Postgres 접속은 비밀번호 기반이라 없앨 수 없음.
→ **없앨 수 있으면 없애고, 없앨 수 없으면 가둔다.**

솔직한 한계: 환경변수로 주입되므로 컨테이너 안에서는 결국 평문.
진짜 이득은 배포 설정·로그에 남지 않는다는 것 + IAM 통제 + 감사 로그.

### ★ pooler 호스트를 쓸 것 (direct 아님)

`db.<ref>.supabase.co` 는 **IPv6 전용**. Cloud Run 은 Direct VPC egress 없이 IPv6 아웃바운드가 없음
→ `ENETUNREACH` 로 실패

Transaction pooler 문자열 사용: `aws-0-ap-northeast-2.pooler.supabase.com:6543`
Transaction 모드가 Cloud Run 에 맞음.

### 지연 측정 (2026-08-10, 서울-서울)

```
cold connect (TCP+TLS+auth)  33.69ms
select 1                     min 6.02 / median 6.35 / p95 7.02
membership check             min 6.17 / median 6.41 / p95 10.84
```

**멤버십 쿼리가 `select 1` 과 사실상 동일 → 쿼리 비용 0, 전부 왕복 시간. 인덱스가 제 역할 중.**

**→ Cloud SQL 이전 검토 종료.** 줄일 수 있는 건 6.4ms 중 몇 ms 인데
같은 요청의 Cloud Run 콜드 스타트는 수백 ms. 대가는 카카오 로그인 직접 구현 + 참조 무결성 상실 + 월 $10~30.

**리전을 먼저 고친 게 결정적이었음.** 뭄바이 숫자(100ms+)를 봤다면
"역시 GCP 로 옮겨야겠다"는 잘못된 결론에 도달했을 것. 실제 원인은 프로젝트 생성 시 리전 하나.

### TLS 검증 (2026-08-10 완료)

#### 왜 인증서가, 그리고 CA 가 필요한가

**출발점**: Cloud Run 이 `aws-0-ap-northeast-2.pooler.supabase.com` 이라는 **이름**으로 접속함.
그런데 그 이름에 응답한 상대가 정말 Supabase 인지 어떻게 알까?

DNS 는 이름을 IP 로 바꿔줄 뿐 신원을 보장하지 않음. 중간에 누가 끼어들어
"내가 그 호스트야" 라고 답할 수 있음. 그러면 Cloud Run 은 **DB 비밀번호를 가짜 서버에 그대로 넘겨줌.**
(그 비밀번호가 Secret Manager 에 잘 보관돼 있어도 소용없음 — 우리가 자발적으로 건네주는 것이므로)

**1단계 — 서버가 인증서를 내민다**

인증서 = "나는 aws-0-ap-northeast-2.pooler.supabase.com 이다" 라는 **서명된 문서**.
안에 호스트명과 공개키가 들어 있음.

**2단계 — 그런데 인증서는 누구나 만들 수 있다**

내가 "나는 google.com 이다" 라는 인증서를 지금 만들 수도 있음. 그래서 문서 자체로는 아무것도 증명 못 함.
**중요한 건 누가 서명했느냐.**

**3단계 — 그래서 CA (Certificate Authority) 가 필요하다**

CA = 신원을 확인해주는 제3자. 서버가 자기 인증서를 CA 에게 가져가면,
CA 가 실제로 그 도메인의 주인이 맞는지 확인한 뒤 **자기 개인키로 서명**해줌.

그럼 클라이언트는 이렇게 판단함:

```
이 인증서에 붙은 서명이 내가 이미 신뢰하는 CA 의 것인가?
  → CA 의 공개키로 서명 검증  (서명 URL 검증과 똑같은 구조)
  → 유효하면: 그 CA 가 이 서버의 신원을 보증한 것
```

**핵심은 "내가 이미 신뢰하는" 부분.** 클라이언트는 CA 의 공개키를 **미리** 갖고 있어야 함.
그래야 서명을 검증할 수 있음. 처음 보는 CA 라면 그 서명은 아무 의미가 없음.

**4단계 — 그 "미리 갖고 있는 목록" 이 어디 있나**

- 브라우저: 브라우저가 내장한 신뢰 CA 목록
- **Node: Node 가 번들로 갖고 있는 CA 목록** (Mozilla 저장소 기반)

https 사이트에 접속할 때 아무 설정도 안 해도 되는 이유가 이것. 목록이 이미 있으니까.
`rejectUnauthorized: false` 는 이 3~4단계를 **통째로 건너뛰는 것** — 상대가 뭘 내밀든 그냥 받아들임.

**5단계 — Supabase 는 그 목록에 없다**

Supabase 의 pooler 는 공개 CA 가 아니라 **자체 서명 루트**를 씀
(`CN=Supabase Root 2021 CA`). Mozilla 저장소에 없으므로 Node 내장 목록에도 없음.
→ 그래서 옵션 1(내장 목록만으로 검증)이 실패한 것.

→ **그 CA 인증서를 우리가 직접 구해서 "이것도 신뢰해" 라고 알려줘야 함.** 그게 `prod-ca-2021.crt`.

**왜 이 파일이 비밀이 아닌가**

인증서는 **공개키만** 담고 있음. 개인키는 Supabase 만 갖고 있고 이 파일에는 없음.
CA 인증서는 애초에 **널리 배포되라고** 만들어진 것 — 브라우저에 수백 개가 내장돼 있는 것과 같은 성격.
→ Secret Manager 가 아니라 저장소에 커밋. 단 `.crt` 파일이 설정 옆에 있으면 비밀처럼 보이므로 주석 필수.

**우리를 증명하는 것 vs 상대를 확인하는 것**

| | 수단 | 방향 |
|---|---|---|
| 상대(Supabase)가 진짜인가 | 인증서 + CA | Cloud Run 이 검증 |
| 우리가 누구인가 | DB 비밀번호 | Supabase 가 검증 |

은행 사이트와 같은 구조. 은행은 인증서로 자기가 진짜임을 증명하고, 우리는 비밀번호로 우리가 누구인지 증명함.
**서로 다른 수단으로, 서로 다른 방향.** (양쪽 다 인증서를 쓰는 mutual TLS 도 있지만 여기서 하는 건 그게 아님)

#### 적용

측정 중에는 `rejectUnauthorized: false` 로 두었음 — 인증서 문제가 "연결 실패"로 위장하면 측정이 무의미해지므로.
측정이 끝나고 실제 엔드포인트 작성 전에 켰음.

**방향 주의**: 설정이 우리 `pg` 풀에 있는 이유는 **검증하는 쪽이 우리**이기 때문. Supabase 쪽에 하는 게 아님.

- 옵션 1: Node 내장 CA 목록으로 `rejectUnauthorized: true` → **실패**
- 옵션 2: Supabase CA 인증서를 명시 지정 → **채택**

```
ppoddo-api/certs/prod-ca-2021.crt    ← 저장소에 커밋 (만료 2031-04-26)
ssl: { ca, rejectUnauthorized: true }
```

**구현 시 걸렸던 것들**

- `"type": "module"` 이라 `__dirname` 이 없음 → `dirname(fileURLToPath(import.meta.url))` 로 경로 해석.
  상대 경로 문자열은 작업 디렉터리에 따라 깨짐
- `.gcloudignore` 확인 필요 (certs/ 나 *.crt 가 제외되면 컨테이너에 파일이 없어 연결 실패,
  그런데 에러는 네트워크 문제처럼 보임). `gcloud meta list-files-for-upload` 로 실제 포함 여부 확인함
- 인증서 없으면 **시작 시점에** 명확한 에러로 죽게 함 (쿼리마다 TLS 에러가 나는 것보다 나음)
- 시작 로그에 만료일 출력. 90일 미만이면 경고, 지났으면 에러
  → 조용한 만료로 백엔드가 멈추는 걸 방지

**★ `rejectUnauthorized: false` 가 두 곳에 있었음** — 풀과, `/debug/db` 의 별도 콜드 커넥트 클라이언트.
→ `DB_SSL` 상수 하나로 통합. **측정하는 경로와 실제 경로가 다르면 측정이 거짓말을 함.**

**지연 영향 없음**

배포 직후 첫 호출에서 콜드 커넥트가 67.4ms 로 튀었으나(기준 33.69ms), 5회 재측정 결과
28.64~36.62ms 로 기준선 주변. 67ms 는 TLS 가 아니라 컨테이너 콜드 스타트였음.
풀링된 쿼리는 6.4ms / 6.4ms 로 정확히 동일 — pooler 는 이미 TLS 를 하고 있었고,
체인 검증은 이미 받은 인증서에 대한 로컬 CPU 작업이라 예상과 일치.

**Vercel 때 이런 게 없었던 이유**: 그때는 `@supabase/supabase-js` 로 HTTPS REST API 를 호출.
공개 CA 라 자동 검증됨. 지금은 `pg` 로 Postgres 에 TCP 직접 연결이라 다른 엔드포인트.

**그럼 supabase-js 를 쓰면 되지 않나**: 가능하지만 트랜잭션(media + media_groups 를 원자적으로),
복잡한 쿼리(교집합 인가, 날짜 피드 조인), 그리고 앱→Cloud Run→PostgREST→Postgres 로 한 겹 더 늘어남.
→ 직접 연결이 맞고, CA 파일 하나가 그 대가.

---

# 스키마 결정

`0001_init.sql` — 백엔드 저장소에 둘 것 (앱은 Postgres 에 직접 붙지 않음).
Expo 프로젝트가 필요해서가 아니라, 버전 관리되는 곳이 필요해서.

**users.id = auth.users.id (같은 UUID)**
새 UUID 를 만들면 매 요청마다 `JWT sub → app id 찾기 → memberships` 로 조회가 한 번 더 늘어남.
같은 값을 쓰면 `sub` 이 곧 앱의 사용자 ID.

**public.users 행은 트리거가 아니라 백엔드가 온보딩 완료 시 생성**
→ 행의 존재 자체가 "온보딩 완료" 신호. 별도 플래그 불필요.
→ 모든 엔드포인트가 "유효한 JWT, 프로필 없음" 을 온보딩으로 보내야 함
→ 생성 엔드포인트는 `on conflict (id) do nothing` 으로 멱등하게

**사진과 영상은 한 테이블(`media`), `kind` enum 으로 구분**
테이블이 둘이면 (1) 섞인 날짜 피드가 두 번 조회 후 병합 → 페이지네이션 지옥
(2) comments 가 다형성 참조가 되어 진짜 외래 키를 못 검

**날짜 컬럼 — 두 가지가 서로 다른 질문에 답함**

- `created_at` : 언제 업로드됐나 (시스템 소유, 불변, UTC)
- `posted_on`  : **어느 캘린더 날짜에 보이나** (사용자 소유, 수정 가능)

**3월에 찍은 사진을 8월에 올리면 8월 캘린더에 들어감.**

**왜 촬영일이 아니라 게시일 기준인가**: 조부모님은 캘린더를 거슬러 올라가지 않고 최근 며칠만 열어보심.
옛날 사진을 과거 칸에 넣으면 **아무도 못 봄** — 올린 사람만 알고 끝남.
뽀또는 아카이브가 아니라 **공유 채널**(2.2)이므로, 캘린더는 "시안이의 연대기"가 아니라
"무엇이 언제 공유됐나"의 타임라인.

**그럼 왜 `created_at` 을 그냥 쓰지 않는가** — 두 가지 때문:
1. `created_at` 은 UTC 라 날짜만 뽑으면 하루가 밀림. `posted_on` 은 백엔드가 **KST 로 계산**해 넣을 것
2. 수정 가능해야 함. 승희가 새벽 1시에 올리면 `created_at` 은 15일이지만 14일 밤의 사진임
   → 14일로 옮길 수 있어야 함

comments 의 날짜 댓글도 같은 기준(`posted_on`)을 참조.

**EXIF 촬영 시각은 v1 범위 밖.** 매일 그날 사진을 올리는 게 주 패턴이라 촬영일과 게시일이 대개 같음.
필요해지면 `captured_at` 을 추가.
부수 효과로 **앱이 EXIF 를 읽을 필요가 없어짐** — 백엔드가 `now()` 를 KST 로 변환하면 끝.

> **경로 설계와의 관계**: `posted_on` 이 수정 가능하다는 게 바로 날짜를 GCS 경로에 넣지 않은 이유(5.2).
> 가변 값은 Postgres 에, 경로에는 불변인 것만.

**일반화: "언제 기록됐나" · "언제 일어났나" · "어디에 보이나" 는 서로 다른 컬럼.**
하나로 합치고 싶어지지만, 어긋나는 순간이 반드시 오고 그때는 이미 데이터가 쌓여 있음.

**복합 기본 키 (memberships, media_groups)**
키 자체가 중복 가입/중복 공유를 막음 → 별도 unique 제약 불필요.
두 번째 컬럼에 보조 인덱스가 필요한 이유 둘:
(1) `where group_id = ?` 는 복합 인덱스를 못 탐 (첫 컬럼부터 정렬되므로)
(2) **Postgres 는 외래 키에 인덱스를 자동 생성하지 않음** → cascade 삭제 시 전체 스캔 + 락

*단 사용자 6명 규모에서 성능 차이는 0. 습관과 정확성의 문제지 측정 가능한 이득이 아님.*

**1회용은 boolean 이 아니라 타임스탬프**
`invite_codes.used_at` + `used_by`. `used_at is null` 이면 boolean 과 같은 판정인데
언제·누가 썼는지가 추가로 남음. **시안이 사진에 접근할 수 있는 사람이 어떻게 늘어났는지의 기록.**
사용된 코드는 삭제하지 말 것.
→ 일반화: 상태를 boolean 으로 표현하고 싶을 때 "언제"가 의미 있는지 물어볼 것. 대개 의미 있음.

**RLS 는 전 테이블 ON, 정책은 0개 (기본 거부)**
`anon` 키가 앱 번들에 들어가므로 누구나 꺼내서 Supabase REST API 를 직접 호출 가능(Cloud Run 우회).
RLS 가 꺼진 테이블은 그 키만으로 전부 읽힘.

> **RLS 는 우리 인가 로직의 안전망이 아님.** Cloud Run 은 service_role 로 접속해 RLS 를 우회하므로,
> 멤버십 검사에 버그가 있으면 뒤에 아무것도 없음. GCS + 자체 백엔드를 택하며 감수한 비용.

확인 쿼리:
```sql
select tablename, rowsecurity from pg_tables
where schemaname = 'public' order by tablename;
```

---

# Phase 2 — 인증

## OAuth 로그인 — 전체 과정

### 왜 이렇게 복잡한가

**목표**: 승희의 구글 비밀번호를 뽀또가 절대 보지 않으면서 "이 사람이 누구인지"만 확인받는 것.

**제약 두 개가 구조를 결정함**:
1. 앱은 **고정된 비밀을 가질 수 없음** — 번들을 뜯으면 누구나 꺼냄
2. 브라우저와 딥링크는 **안전한 경로가 아님** — 주소창, 로그, 다른 앱이 볼 수 있음

### 단계별

**① 앱이 비밀을 만든다** (브라우저가 열리기 전)
```
code_verifier  = "xK9mP2..."           앱만 아는 일회용 비밀
code_challenge = SHA256(code_verifier)  그 해시
```
`code_verifier` 는 앱 메모리에만 있고 네트워크를 지나가지 않음.
⑦에서 신분증으로 쓰려고 미리 만드는 것.

**② 앱 → Supabase: 로그인 시작**
```
code_challenge, redirect_to = ppoddo://auth
```
Supabase 가 이번 로그인 건에 challenge 를 묶어 보관. ⑦의 대조 기준.
원본이 아니라 해시만 보내는 게 핵심 — **약속은 공개해도 되고, 증거는 숨긴다.**

**③ 브라우저가 구글로**
```
client_id     = 어느 앱의 요청인지 (승희에게 "뽀또가 요청합니다"를 보여주려고)
redirect_uri  = 코드를 받을 주소 (사전 등록된 곳만 — 공격자가 빼돌리는 걸 막음)
response_type = code
```
iOS 에서는 `ASWebAuthenticationSession` 이라 **사파리와 쿠키를 공유** →
이미 구글에 로그인돼 있으면 비밀번호를 다시 안 쳐도 됨. 조부모님에게 중요.

**④ 구글 → Supabase: 인가 코드 A (구글이 발급)**
```
?code=4/0AeanS0b7x...
```
> 인가 코드가 두 번 나옴. 헷갈리기 쉬우니 구분해서 부름:
> **코드 A** = 구글이 발급, 구글이 검증 (④→⑤)
> **코드 B** = Supabase 가 발급, Supabase 가 검증 (⑥→⑦)
> 서로 다른 문자열이고, 발급자와 검증자가 다름. **앱은 코드 A 를 본 적이 없음.**

**⑤ Supabase ↔ 구글: 서버끼리 교환 (코드 A 소모)**
```
보냄: 코드 A + client_secret
받음: { sub, email, name }
```
`client_secret` 은 브라우저를 안 지나가므로 비밀로 유지됨.
**여기서 구글의 역할이 끝남.** 코드 A 도 소모되어 죽음. 이후 구글 토큰은 안 씀.

**⑥ Supabase → 앱: 인가 코드 B (Supabase 가 발급)** (딥링크)
```
ppoddo://auth?code=b3f9c1d2-...
```
딥링크도 위험한 경로 — 다른 앱이 같은 스킴을 등록해 가로챌 수 있음.
그래서 여기도 토큰 대신 코드.

**⑦ 앱 → Supabase: 교환 (코드 B 소모)**
```
보냄: 코드 B + code_verifier
```
- **코드 B** → **어느 로그인 건인지 지목.** ⑤에서 알아낸 승희 정보가 이 코드에 묶여 있음
  (앱이 ⑥에서 딥링크로 받은 그 값. 구글의 코드 A 와는 다른 문자열)
- `code_verifier` → **그 건의 주인이 맞는지 증명** (Supabase 가 해시해 ②의 challenge 와 대조)

둘 다 필요함. 코드만으로는 가로챈 앱도 교환 가능하고, verifier 만으로는 어느 건인지 알 수 없음.

**⑧ 세션 수령** — 아래 참조

### 핵심 패턴: 같은 구조가 두 층으로 반복됨

```
층 1  구글 ↔ Supabase :  코드 A → client_secret 과 함께 교환 → 구글 토큰
층 2  Supabase ↔ 앱   :  코드 B → code_verifier 와 함께 교환 → JWT
```

**위험한 경로로는 코드만 보내고, 안전한 경로에서 신분증과 함께 진짜 토큰으로 바꾼다.**
차이는 신분증의 종류뿐 — 서버는 고정된 `client_secret`, 앱은 매번 새로 만든 `code_verifier`.

### 인가 코드란

짧은 무작위 문자열. **1회용 · 단기(10분) · 교환 전용.** 그 자체로는 아무 권한 없음.

물품보관소 번호표. 번호표는 **어느 물건인지**를 알려주고, 신분증은 **그게 네 것인지**를 증명.
번호표만 주웠다고 남의 짐을 못 가져감.

유출돼도 별일 없는 이유: 신분증이 없으면 교환 불가 + 10분이면 만료 + 1회용이라 이미 쓰였으면 무효.

> **서명 URL 과 대비**: 서명 URL 은 **그 자체가 자격 증명**이라 가진 사람이 곧 인가받은 사람.
> 인가 코드는 정반대로 **혼자서는 아무것도 못 하는 물건.**

### PKCE 가 모바일에서 필수인 이유

악성 앱이 `ppoddo://` 스킴을 똑같이 등록해두면 ⑥의 딥링크를 가로챌 수 있음 (iOS 에서 가능).
그런데 교환이 안 됨 — `code_verifier` 가 없으므로. 공격자가 본 건 해시인 `code_challenge` 뿐이고
해시에서 원본은 되돌릴 수 없음.

**딥링크는 가로챌 수 있는 통로 + 앱은 비밀을 숨길 수 없음 → 매번 새 비밀을 만드는 것 말고 방법이 없음.**

### 왜 딥링크를 쓰는가

OAuth 는 브라우저를 거치고, 브라우저는 앱과 분리된 곳이라 **돌아올 통로**가 필요함.
웹에서는 같은 탭에 리디렉션이 떨어지니 필요 없지만, 네이티브 앱에는 그 공유된 창이 없음.

**앱 안에 WebView 를 띄우면 안 되나** → 구글이 막아둠 (`disallowed_useragent`).
앱은 자기 안의 WebView 를 들여다볼 수 있음 = 구글 비밀번호를 읽을 수 있음
= OAuth 가 존재하는 이유 자체가 무너짐.

---

## Supabase 가 주는 것

```json
{
  "access_token":  "eyJhbGciOiJSUzI1NiIsImtpZCI6...",
  "refresh_token": "v1.Mr3kQp...",
  "expires_at":    1786891200,
  "user": {
    "id":    "9c8afed5-...",
    "email": "seunghee@gmail.com",
    "app_metadata":  { "provider": "google" },
    "user_metadata": { "name": "승희" }
  }
}
```

**access_token(JWT) 안:**
```json
{ "sub": "9c8afed5-...", "exp": 1786891200, "iss": "https://<ref>.supabase.co/auth/v1" }
```

`sub` 이 곧 앱의 사용자 ID. `public.users.id` 를 `auth.users(id)` 와 같은 UUID 로 맞춰둔 이유.
매핑 조회가 필요 없음.

**★ `user` 객체 안의 이메일·이름을 백엔드가 믿으면 안 됨.**
앱이 보낸 JSON 이 아니라 **JWT 안의 `sub` 만** 신뢰의 근거.
표시 이름이 필요하면 `public.users` 에서 조회 (온보딩 때 사용자가 직접 정한 값).

### 앱에서의 사용

세션은 `supabase-js` 가 AsyncStorage 에 저장하고 만료 전에 자동 갱신.
앱 코드는 필요할 때 꺼내 쓰기만 함.

```js
const { data } = await supabase.auth.getSession()
fetch(url, { headers: { Authorization: `Bearer ${data.session.access_token}` } })
```

**매번 세션에서 꺼낼 것.** 변수에 캐시해두면 백그라운드 갱신 후 낡은 값이 남아,
서버 문제처럼 보이는 실패가 남.

---

## Cloud Run 의 JWT 검증

### JWT 구조 — 점으로 나뉜 세 조각

```
eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYzEyMyJ9 . eyJzdWIiOiI5Yzh... . QXZ4bE...
        헤더                                    페이로드            서명

헤더    { "alg": "RS256", "kid": "abc123" }
페이로드 { "sub": "...", "exp": ..., "iss": "..." }
```

**★ 페이로드는 암호화가 아니라 base64 인코딩일 뿐.**
누구나 열어볼 수 있고, `sub` 을 남의 UUID 로 고쳐 쓰는 것도 30초면 됨.
**막아주는 건 세 번째 조각인 서명 하나뿐.**

### 검증 순서

```
1. 헤더의 kid 를 읽음          → 어느 키로 서명했는지 (키 교체 대비)
2. JWKS 에서 그 공개키를 가져옴  → 캐시 필수. 단 kid 가 없으면 1회 재조회
3. header.payload 를 SHA-256 → 지문
   공개키로 서명을 확인 → 그 지문과 맞는가
4. 클레임 확인: exp(만료), iss(우리 프로젝트가 맞나), alg
5. sub 추출 → 하드코딩 상수 자리에 들어감
```

3번은 **GCS 서명 URL 검증과 완전히 같은 구조.** 개인키로 만들고 공개키로 확인.

### ★ alg 를 반드시 고정할 것

공격자가 헤더의 `alg` 를 `none` 이나 `HS256` 으로 바꿔 보내는 유명한 공격이 있음.
라이브러리가 헤더를 그대로 믿으면 검증을 건너뛰거나, **공개키를 HMAC 비밀번호로 써버림**
— 공개키는 누구나 아니까 그대로 뚫림.

**헤더가 말하는 알고리즘을 믿지 말고 우리가 기대하는 값(RS256)을 고정.**

직접 짜지 말 것. `jose` 가 JWKS 캐싱, kid 매칭, alg 고정을 다 처리함.

### 상태 코드는 구분해서

| 코드 | 의미 | 앱이 할 일 |
|---|---|---|
| 401 | 토큰 없음·손상·만료·검증 실패 | 갱신 후 1회 재시도, 실패하면 재로그인 |
| 403 | 토큰은 정상, 그 그룹 멤버가 아님 | 접근 권한 없음 표시 |
| (프로필 없음) | 토큰은 정상, `public.users` 행 없음 | 온보딩 화면 |

뭉뚱그리면 조부모님이 "안 돼요" 하실 때 원인을 알 수 없음.

---

## ★ JWT 와 서명 URL 의 결정적 차이

**앱은 서명하지 않음.** 개인키가 없음. JWT 는 로그인 시점에 Supabase 가 한 번 만들어준 것이고,
앱은 그 완성품을 **요청마다 그대로 붙여 보낼 뿐** — 계산 없음.

| | 서명이 덮는 범위 |
|---|---|
| GCS 서명 URL | 메서드 + 객체 경로 + 만료 + 지정된 헤더값 |
| JWT | **JWT 자신의 header.payload 뿐** |

JWT 의 서명은 **요청 내용과 무관.** 어느 URL 로 보내든 본문에 뭘 담든 서명은 그대로.
같은 토큰으로 업로드도 조회도 함.

**→ 서명 URL 은 "누가 + 무엇을"을 묶어 증명하지만, JWT 는 "누구인가" 하나만 증명.**

### 따라 나오는 것

토큰이 요청에 묶여 있지 않으므로, **훔치면 아무 요청에나 쓸 수 있음.** 그래서:

- **HTTPS 필수** — 평문으로 지나가면 그대로 털림
- **짧은 만료(1시간)** — 훔쳐도 오래 못 씀. 리프레시 토큰이 자동 갱신을 담당하는 이유

그리고 이것이 **"인가는 매 요청마다 DB 로 확인한다"** 는 결정과 이어짐.
JWT 는 신원만 말해주므로 "이 사람이 이 그룹 걸 볼 자격이 있나"는 답할 수 없음.
그건 `memberships` 가 답함.

---

# 앞으로 계속 쓸 원칙

- **추측하지 말고 측정할 것.** expo-video 캐시, 서명 동작, DB 지연 — 전부 몇 분짜리 테스트가 설계를 바꿨음.
  결과는 **버전과 함께** 기록할 것.
- **모르는 것 하나만 떼어내서 시험할 것.** 전체를 만들고 확인하면 실패 원인이 모호해짐.
- **설정이 성공했다는 건 동작한다는 뜻이 아님.** (`application-default login --impersonate` 이 그랬음)
- **에러 메시지가 원인을 잘못 가리킬 수 있음.** (결제 에러 → 실제로는 오래된 SDK)
- **경로·이름 등 불변인 것에만 영구적인 값을 담을 것.** 가변 상태는 DB 로.
- **없앨 수 있는 비밀은 없애고, 없앨 수 없으면 가둘 것.**