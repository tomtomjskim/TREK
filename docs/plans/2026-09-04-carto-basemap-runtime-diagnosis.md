# CARTO Basemap Runtime Diagnosis

> 작성일: 2026-09-04
> 상태: 원인 확인; v4.2.0 격리 후보에 계약 보존·focused 검증 반영; 운영 변경 없음
> 범위: 계획 탭 지도에서 보이는 `API KEY REQUIRED` 워터마크
> 로컬 코드 근거: 계획 탭 fallback `14a1796d`, public map 격리 `69f83999`, public Journey 서버/클라이언트 경계 `d4f8ed9f` + `3ee91284`; 최종 code/test descendant `a55fcccb`

## 결론

현재 운영 중인 TREK v3.4.1 fork는 사용자 지도 URL이 비어 있으면 키 없는 CARTO raster
URL을 기본값으로 사용한다. 운영 DB의 비밀값 비노출 집계에서도 `carto_api_key` 설정 행은
0개이고 `map_tile_url` 한 행은 빈 값이었다. 따라서 현재 증상은 등록된 키의 만료가 아니라
**운영 앱에 CARTO key binding이 없고 v3 기본값이 keyless CARTO로 해석되는 문제**다.

CARTO 계정에서 발급받은 외부 키 자체의 정지·회수 여부는 키를 사용하거나 CARTO 계정을
조회하지 않았으므로 판단하지 않는다. CARTO는 basemap key의 고정 만료일을 공개하지 않지만
키를 suspend/revoke/rate-limit할 수 있다고 명시한다.

공식 TREK v4.1.1 release note도 기존 CARTO template의 `API KEY REQUIRED` 회피와 settings
preview의 key 전달 누락을 해당 release에서 수정했다고 명시한다. 다만 2026-09-04 재확인한
GitHub의 `releases/latest`는 2026-09-03 공개된
[v4.2.0](https://github.com/liketrek/TREK/releases/tag/v4.2.0)으로 바뀌었다. 따라서 아래
v4.1.1 동작 검증은 유효한 중간 근거지만, 최신 배포 후보는 v4.2.0 증분 통합에서 같은 계약을
다시 확인해야 한다.

## 비밀값 비노출 증거

| 확인            | 결과                                               | 판정                         |
| --------------- | -------------------------------------------------- | ---------------------------- |
| 운영 컨테이너   | `trek:3.4.1-jsnetworkcorp-7a50356e`, healthy       | 현재 runtime은 v4.1.1이 아님 |
| 운영 schema     | 175                                                | v3.4.1 baseline과 일치       |
| `carto_api_key` | rows 0, configured 0, encrypted 0                  | 앱에 저장된 CARTO key 없음   |
| `map_tile_url`  | rows 1, empty 1, CARTO URL 0, embedded key 0       | v3 코드의 기본 URL이 사용됨  |
| 무키 tile probe | HTTP 200 PNG, 이미지에 `API KEY REQUIRED` 워터마크 | provider 증상 재현           |

운영 DB 확인은 `sqlite3 -readonly`와 `COUNT`/`CASE` 집계만 사용했다. 설정 값, 키 문자열,
사용자 식별자, 쿠키, `.env` 및 민감 로그는 읽거나 기록하지 않았다.

## v3.4.1 원인 경로

- `client/src/pages/tripPlanner/useTripPlanner.ts`는 `map_tile_url`이 비면
  `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png`를 사용한다.
- v3 설정 UI에는 `carto_api_key` 입력 필드가 없다.
- v3 settings service는 `carto_api_key`를 암호화 대상 key로 취급하지 않는다.
- 따라서 CARTO 사이트에서 키를 발급받았더라도 v3 정상 UI만으로는 계획 지도 요청에 연결할
  수 없다.

## v4.2.0 격리 후보 개선 계약

격리된 v4.2.0 통합 후보는 v4.1.1에서 확인한 다음 경로를 유지한다.

1. `MapSettingsTab`과 모바일/관리자 설정에서 `carto_api_key`를 저장한다.
2. Nest settings service가 key를 암호화 저장하고 사용자 → 관리자 기본값 → managed operator
   설정 우선순위로 합성한다.
3. `useTileUrl`/`resolveTileUrl`이 CARTO host에만 key를 붙인다.
4. CARTO URL인데 key가 없으면 tokenless OpenFreeMap style로 대체한다.
5. 계획 탭은 해석된 URL을 `MapViewAuto`에 전달한다.
6. 익명 Journey 지도는 저장된 tile template/key를 읽지 않고 keyless OpenFreeMap을 강제하며,
   공개 API의 `cartoApiKey` 호환 필드는 항상 빈 문자열이다.
7. 설정 key는 URL에 바인딩하기 전에 trim한다. 빈 문자열 또는 whitespace-only 값은 key가
   없는 것으로 처리하여 OpenFreeMap fallback을 선택한다.

관련 focused 계약은 settings service 34 tests, map/settings/planner 198 tests에서 통과했고,
통합 후보의 `tileUrl` 회귀는 27/27로 trim·whitespace-only fallback을 확인했다.
인증된 계획 탭 Playwright도 settings UI에 저장된 CARTO template이 실제로 로드됐음을 확인한
뒤, keyless 상태에서 CARTO 요청 0건과 OpenFreeMap 요청·지도 표시를 검증했다. v4 client와
v3 server를 혼합하면 키가 평문으로 저장될 수 있으므로 두 계층은 원자적으로 승격해야 한다.

## 계획 탭 브라우저 증거

`client/e2e/map-label-language.spec.ts`의 focused 실행은 auth setup 1개와 app test 2개를
합쳐 3/3 통과했다. 이 중 CARTO fallback 회귀는 app test 1/1이다. 새 회귀 시나리오는 다음을
한 테스트 수명 안에서 확인하고 원래 설정과 생성 trip을 복구·삭제한다.

1. key가 없는 격리 DB에 CARTO raster template을 저장한다.
2. `/api/settings` 재조회와 `/settings?tab=map` input에서 같은 template을 확인한다.
3. 계획 탭을 열고 OpenFreeMap 지도 요청이 모두 끝난 뒤 1초간 추가 지도 요청이 없는 시점까지
   관찰한다.
4. OpenFreeMap 요청은 존재하고 `basemaps.cartocdn.com` 요청은 0건임을 확인한다.

[계획 탭 증거](../screenshots/carto-keyless-openfreemap-plan.png)는 OpenFreeMap 지도와
attribution이 표시되고 `API KEY REQUIRED` 워터마크가 없음을 육안 검수했다. 이 브라우저
증거는 로컬 후보 동작에 대한 것이며 전체 release gate나 운영 배포 완료를 의미하지 않는다.
이미지는 1280×720 PNG이며 SHA-256은
`b32768fa3eca655609d1693c70ef734d9ba5c9af71b4ee76a8abf2e9247a2c68`이다.

## 배포 후 안전 확인 절차

1. `/api/auth/app-config`의 version/managed 상태만 확인하고 v4.2.0 server/client가 함께
   승격됐는지 확인한다.
2. 키가 없는 상태에서 계획 탭 요청 host가 `tiles.openfreemap.org`이고 CARTO tile 요청이
   없는지 확인한다.
3. CARTO를 계속 사용할 경우 v4 설정 화면에서 키를 다시 입력하고 저장/재로드를 확인한다.
   브라우저 증거에는 query 값을 남기지 않고 `key=<redacted>`로만 기록한다.
4. CARTO 요청에 key가 있는데 401/403 또는 워터마크가 남으면 그때 CARTO 측 key 상태,
   신청 도메인 및 월 사용량을 확인한다.
5. OpenFreeMap/CARTO/OSM attribution과 console/network 오류를 390px 및 1440px 계획 탭에서
   확인한다.

## 결정과 경계

- v3에 임시 key를 직접 주입하지 않는다. 정상 UI 계약이 없고 평문 저장 위험이 있다.
- 권장 경로는 검증된 v4.1.1 CARTO 계약을 official v4.2.0 증분 branch에 보존한 뒤
  server/client를 원자적으로 승격하는 것이다.
- 현재 v4.2.0 branch는 로컬 격리 후보이며, restore/image/browser gate와 별도
  승인 전에는 main merge·push·production deploy를 수행하지 않는다.
- CARTO 공식 근거:
  [Basemap API key 안내](https://carto.com/basemaps/apikey/),
  [Basemap Terms](https://carto.com/legal/basemap-terms/).
