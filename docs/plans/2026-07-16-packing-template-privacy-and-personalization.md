# 짐 템플릿 프라이버시·개인화 구현 계획

> 작성일: 2026-07-16
> 상태: Gate 0 보완 및 검증 중, 개인 템플릿 구현은 아직 시작하지 않음

## 목표와 결정

개인마다 다른 짐 목록을 소유·재사용할 수 있게 하되, 여행의 `Personal`/`Shared` 항목이나 다른 사용자의 개인 템플릿이 REST, MCP, 플러그인, WebSocket, 오프라인 캐시, 여행 복사 경로를 통해 노출되지 않도록 한다.

서브에이전트의 CRUD 권한 검토, 사이드 이펙트 검토, 적대적 평가 결과는 `review result: fail`, `block`이었다. 개인 템플릿을 바로 추가하면 기존 짐 항목의 ID 기반 우회와 캐시 잔존 문제가 새 기능까지 전파되므로 다음 순서를 강제한다.

1. **Gate 0:** 기존 짐 항목 프라이버시 경계를 수정·배포·교차 사용자 검증한다.
2. **R1:** 템플릿 scope 스키마와 모든 기존 조회 경로의 `instance` 필터만 먼저 배포한다. 개인 쓰기 기능은 비활성화한다.
3. **R2:** R1을 롤백 하한선으로 삼고 개인 템플릿 API/UI를 활성화한다.

기존 `POST /api/trips/:tripId/packing/save-as-template`는 관리자 전용 공용 템플릿 저장 작업으로 유지한다. 일반 사용자의 개인 저장을 위해 이 권한을 완화하지 않는다.

## 비목표

- 운영자가 일반 애플리케이션 API로 개인 템플릿 내용을 열람하는 기능
- Shared 항목 수신자가 원본 항목이나 소유자의 개인 템플릿을 편집하는 기능
- R1 이전 이미지로의 무조건적인 코드만 롤백
- 개인 템플릿과 공용 템플릿을 하나의 모호한 관리 화면에서 혼합하는 것

## Gate 0: 기존 짐목록 프라이버시 선행 보완

### 적대적 검토에서 확인한 차단 이슈

- `packing_edit` 권한을 가진 여행 구성원이 항목 ID를 알면 다른 사람의 Personal/Shared 항목을 수정·삭제·공용화·복제할 수 있었다.
- 여행 bundle 조회가 viewer ID 없이 전체 짐목록을 반환할 수 있었고, IndexedDB `bulkPut`은 서버에서 더 이상 보이지 않는 기존 행을 남겼다.
- 여행 복사가 모든 비공개 항목을 복사하면서 Common으로 변환할 수 있었다.
- MCP의 비공개 항목 수정/체크 이벤트가 여행 전체 방에 내용을 방송할 수 있었다.
- 정렬·일괄 체크·카테고리 동작이 현재 보기 밖의 숨은 ID까지 건드릴 가능성이 있었다.
- Shared 수신자 UI에 수정 컨트롤이 노출되어 서버 정책과 사용자 기대가 어긋났다.

### Gate 0 권한 계약

| 대상/동작 | Common | Personal | Shared |
| --- | --- | --- | --- |
| 조회 | 여행 구성원 | 소유자 | 소유자와 지정 수신자 |
| 생성 | `packing_edit` 사용자 | `packing_edit` 사용자, 본인 소유 | 소유자가 수신자를 명시 |
| 이름·수량·체크·가방·삭제 | `packing_edit` 사용자 | 소유자만 | 소유자만, 수신자는 읽기 전용 |
| 공개 범위·수신자 변경 | 항목 소유자만 | 소유자만 | 소유자만 |
| 복제 | Common만 허용 | 거부 | 거부 |
| 정렬 | 보이는 Common + 본인 소유 제한 항목만 | 소유자만 | 소유자만 |
| 기여자 제거 | 본인 탈퇴 또는 항목 소유자 | 본인 탈퇴 또는 항목 소유자 | 본인 탈퇴 또는 항목 소유자 |

권한 없음과 존재하지 않는 ID는 모두 `404`로 응답하여 객체 존재 여부를 노출하지 않는다. REST, MCP, 플러그인 RPC가 같은 서비스 계층 권한 검사를 사용해야 한다. 관리자 역할도 일반 여행 API에서 Personal/Shared 내용을 자동으로 우회 열람하지 않는다.

### Gate 0 구현 범위

- 모든 item 조회/수정/삭제/정렬 서비스 호출에 actor ID를 필수화한다.
- 여행 bundle 및 목록 조회에 viewer ID를 필수화한다.
- 여행 복사는 Common과 복사 요청자 소유 제한 항목만 복사한다. 제한 항목은 새 여행에서 요청자 소유 Personal로 유지하고 수신자·기여자·담당자 연결은 복사하지 않는다.
- 비공개 WebSocket 이벤트는 소유자와 현재 수신자에게만 전송한다.
- 온라인 bundle/list 응답은 해당 여행의 IndexedDB 스냅샷을 원자적으로 교체한다. 접근권이 사라진 여행 캐시는 제거한다.
- Shared 수신자는 체크를 포함한 모든 수정 컨트롤을 읽기 전용으로 본다.
- 현재 활성 보기에서 수정 가능한 항목만 일괄 체크 해제·카테고리 삭제·정렬 대상이 된다.
- 공용 템플릿 snapshot은 `is_private = 0` 항목만 포함한다.

### Gate 0 필수 증거

- 다른 구성원의 Personal/Shared 항목 ID를 사용한 REST/MCP/플러그인 수정·삭제·복제·정렬이 실패한다.
- Shared 수신자에게 항목 내용 변경 UI가 없고 직접 API 호출도 실패한다.
- 공개 범위 전환 전후 WebSocket 수신자 집합이 정확하다.
- 서버에서 사라진 제한 항목과 접근 철회 여행이 IndexedDB에 남지 않는다.
- 여행 복사 후 제한 항목은 요청자 소유 Personal이며 관계 ID가 남지 않는다.
- 기존 공용 템플릿 저장은 Common만 포함하고 eligible 항목이 없으면 빈 템플릿을 만들지 않는다.

Gate 0가 운영에 배포되고 비식별 교차 사용자 검증이 통과하기 전에는 R2를 구현하지 않는다.

## 템플릿 권한 계약

| Template scope | 목록/상세/적용 | 생성/수정/삭제 | Snapshot 원본 | 적용 결과 |
| --- | --- | --- | --- | --- |
| `instance` | 대상 여행 접근 사용자 | 관리자만 | Common만 | Common |
| `personal` | 소유자만 | 소유자만 | 현재 활성 `내 목록`의 호출자 소유 제한 항목만 | 호출자 소유 Personal |

개인 snapshot에는 Shared-to-me 항목과 다른 소유자의 항목을 넣지 않는다. 제외된 항목 수를 저장 확인 화면에 알려 사용자가 누락을 오류로 오해하지 않게 한다. Common을 개인 템플릿에 암묵적으로 섞지 않으며, 공용과 개인 snapshot 출처를 UI에서 명확히 분리한다.

다른 사용자의 개인 템플릿에 대한 목록·상세·적용·수정·삭제는 모두 동일한 `404` 계약을 사용한다. 관리자는 공용 관리 API에서 `scope = 'instance'`만 다루며 개인 템플릿 내용을 열람하거나 수정하지 않는다.

## 데이터 모델과 수명주기

`packing_templates.created_by`는 현재 `NOT NULL ... ON DELETE CASCADE`여서 개인 소유권과 감사용 작성자 정보를 동시에 맡기기에 부적합하다. R1에서 테이블 재구성 migration을 사용해 역할을 분리한다.

```sql
scope      TEXT NOT NULL DEFAULT 'instance'
owner_id   INTEGER REFERENCES users(id) ON DELETE CASCADE
created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
CHECK (scope IN ('instance', 'personal'))
CHECK (
  (scope = 'instance' AND owner_id IS NULL) OR
  (scope = 'personal' AND owner_id IS NOT NULL)
)
```

- 모든 기존 행은 `scope = 'instance'`, `owner_id = NULL`로 backfill한다.
- `created_by`는 감사용 attribution이며 권한 판정에 사용하지 않는다.
- 개인 소유권은 오직 `owner_id`로 판정한다.
- 사용자 삭제 시 개인 템플릿은 `owner_id ON DELETE CASCADE`로 삭제한다. 공용 템플릿은 유지하고 작성자 표기만 `NULL`이 된다.
- `(scope, owner_id, created_at)` 인덱스를 추가한다.
- SQLite 테이블 재구성 전 운영 DB 사본으로 FK, row count, `foreign_key_check`, `integrity_check`를 검증한다.

## 중첩 CRUD 권한 규칙

카테고리나 항목 ID만으로 update/delete하지 않는다. 모든 category/item CRUD는 부모 template까지 JOIN하여 한 번의 조건으로 scope와 소유자를 검사한다.

- 개인 API: `template.scope = 'personal' AND template.owner_id = :actorId`
- 관리자 API: `template.scope = 'instance'`
- 요청 body의 `owner_id`, `created_by`, `scope`는 신뢰하지 않는다.
- 자식이 없거나 권한이 없어도 같은 `404`를 반환한다.
- 목록, 상세, apply, reorder에도 동일한 부모 조건을 적용한다.
- service 함수는 actor ID와 기대 scope를 필수 인자로 받고, controller guard만으로 권한을 대체하지 않는다.

Snapshot 생성, category/item 일괄 삽입, apply는 각각 단일 DB transaction으로 처리한다. 네트워크 재시도 시 중복 적용을 막기 위해 apply/save 요청에 idempotency key를 도입하거나 서버가 동일 요청을 식별할 수 있는 동등한 계약을 마련한다.

초기 방어 한도로 사용자당 개인 템플릿 수, 템플릿당 카테고리/항목 수, 이름 길이, apply 1회 생성 항목 수를 설정한다. 실제 수치는 운영 데이터 분포를 비식별 집계한 뒤 확정하며 초과는 부분 성공 없이 거부한다.

## 단계별 구현

### R1: 롤백 가능한 scope 기반선

1. 운영 SQLite 온라인 백업과 checksum을 만든다.
2. 테이블 재구성 migration, 제약, 인덱스, legacy backfill 테스트를 작성한다.
3. 기존 사용자 목록/apply 쿼리에 `scope = 'instance'`를 강제한다.
4. 기존 관리자 template/category/item CRUD의 모든 자식 쿼리를 부모까지 JOIN해 `scope = 'instance'`로 제한한다.
5. 개인 API와 UI는 feature flag OFF 상태로 둔다.
6. 운영 DB 사본 migration, cross-user negative test, build를 통과한 불변 이미지를 배포한다.

R1이 성공한 뒤 이 이미지를 새 롤백 하한선으로 지정한다. 첫 `personal` 행이 생성된 이후 R1 이전 이미지로 image-only rollback하면 개인 행을 공용으로 노출할 수 있으므로 금지한다. 장애 시 R1 이미지로 롤백하거나 DB 백업을 함께 복원한다.

### R2: 개인 템플릿 API

1. `GET /api/packing-templates?scope=personal|instance`를 추가한다.
2. `POST /api/trips/:tripId/packing/templates`는 scope를 서버에서 `personal`로 고정하고 owner를 JWT 사용자로 설정한다.
3. template/category/item PATCH·DELETE·reorder를 owner-scoped로 구현한다.
4. 개인 apply는 caller-owned Personal 항목을 transaction으로 생성한다.
5. 공용 apply와 기존 trip wrapper 호환성을 유지한다.
6. 템플릿 목록 캐시는 사용자별 key를 사용하고 로그아웃·계정 전환·삭제·접근 철회 시 제거한다.
7. feature flag를 내부 테스트 사용자부터 단계적으로 활성화한다.

### R2 UI/UX

- 적용 화면을 `내 템플릿`과 `공용 템플릿` 탭으로 분리한다.
- 기본 저장 행동은 `내 템플릿`이며 공용 저장은 관리자 화면에만 둔다.
- 관리자 메뉴 이름은 `공용 짐 템플릿`으로 명확히 한다.
- 모바일/Fold 화면에서는 템플릿 관리와 확인을 bottom sheet 또는 전체 화면 흐름으로 제공하고, 지도/패널 닫기 컨트롤과 겹치지 않게 한다.
- 빈 상태를 `저장한 개인 템플릿 없음`, `공용 템플릿 없음`, `저장 가능한 내 항목 없음`으로 구분한다.
- Shared-to-me 제외 개수, 적용 시 생성될 Personal 항목 수를 확인 단계에 표시한다.
- 키보드 포커스, 스크린리더 label, 44px 이상 터치 영역, destructive action 확인/실행 취소를 검증한다.

## 필수 테스트 매트릭스

1. 사용자 A는 B의 개인 템플릿을 목록·상세·적용·수정·삭제할 수 없다.
2. 관리자는 공용 endpoint와 중첩 category/item ID로 개인 템플릿을 열람·수정할 수 없다.
3. 기존 템플릿은 R1 migration 후 `instance`로 남고 목록·상세·적용된다.
4. 공용 snapshot에 Personal, Shared, Shared-to-me 항목이 절대 들어가지 않는다.
5. 개인 snapshot에는 호출자 소유 Personal/Shared만 들어가며 Shared-to-me는 제외된다.
6. 공용 apply는 Common, 개인 apply는 호출자 소유 Personal을 만든다.
7. template/category/item CRUD의 owner 변경·scope 주입·child-ID 직접 접근이 거부된다.
8. snapshot/apply 중간 실패는 template 또는 packing item을 하나도 남기지 않는다.
9. 중복 요청과 재시도는 같은 template/apply 결과를 한 번만 만든다.
10. 사용자 삭제는 개인 템플릿을 삭제하고 공용 템플릿과 nullable attribution은 보존한다.
11. 로그아웃·계정 전환·접근 철회 뒤 오프라인 캐시에서 이전 사용자의 템플릿/짐 항목을 읽을 수 없다.
12. WebSocket payload가 권한 없는 여행 구성원에게 전달되지 않는다.
13. quota 경계와 최대 크기 apply가 원자적으로 성공 또는 실패한다.
14. Fold/모바일/데스크톱에서 생성·이름 변경·적용·삭제 및 오류/빈 상태를 확인한다.

## 배포 전 완료 조건

- Gate 0 및 R1/R2 각 단계에 RED/GREEN 권한 테스트가 존재한다.
- server/client typecheck, 관련 전체 테스트, production build, `git diff --check`가 통과한다.
- 운영 DB 백업의 크기, checksum, SQLite integrity를 확인한다.
- 새 이미지, R1 롤백 이미지, DB restore 절차를 runbook에 기록한다.
- 로그와 감사 이벤트에는 템플릿/항목 이름이나 수신자 목록을 남기지 않고 ID·scope·결과만 기록한다.
- 배포 후 비식별 집계와 두 사용자 교차 권한 테스트를 완료한다.

## 남은 설계 결정

- 운영 분포를 근거로 한 quota 수치
- save/apply idempotency key의 보존 기간과 응답 재사용 규칙
- 개인 템플릿 삭제의 짧은 실행 취소 방식과 영구 삭제 시점
- Shared 소유 항목을 개인 템플릿에 저장할 때 수신자 정보는 제외한다는 UI 문구

위 결정은 R1 구현을 막지 않지만 R2 API 계약과 UI 구현 전에 확정해야 한다.
