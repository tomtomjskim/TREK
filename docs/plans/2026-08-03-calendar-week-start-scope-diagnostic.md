# Calendar Week Start Scope Diagnostic

> 조사일: 2026-08-03
>
> 포크 기준: `68e6b7df255751ed75020c825c2f034345209ce4`
>
> 최신 공식 비교 기준: `upstream/dev`
> `c42aea4171fc7744f663da232f75078b2e3a3b78`
>
> 상태: root cause 확인, 문서화만 완료. 동작 변경·배포·공식 게시 없음

## 사용자 증상과 결론

Vacay 설정에서 주 시작을 일요일로 바꿔도 여행 생성·수정과 여행 안의 일반 일정
날짜 선택기는 월요일부터 표시된다.

이는 저장된 값이 전달 중에 유실되는 runtime binding 오류가 아니다. 현재
`week_start`는 **Vacay plan 전용 설정**이고, 공용 날짜 선택기에는 이를 받거나
읽는 contract가 처음부터 없다. UI에서 설정의 적용 범위가 충분히 드러나지 않아
전역 캘린더 설정처럼 보이는 scope/expectation mismatch다.

## 확인된 데이터 흐름

```text
VacaySettings
  -> updatePlan({ week_start })
  -> vacay_plans.week_start
  -> VacayCalendar
  -> VacayMonthCard.weekStart

TripFormModal / ReservationModal / Todo / Budget
  -> shared CustomDatePicker
  -> Monday-first 계산과 header를 내부에서 고정

JourneyDetailPageDatePicker
  -> 별도 Monday-first 계산과 Mo..Su header를 내부에서 고정
```

### Vacay 전용 경로는 정상이다

- `client/src/components/Vacay/VacaySettings.tsx`는
  `updatePlan({ week_start: value })`를 호출한다.
- `client/src/components/Vacay/VacayCalendar.tsx`는 같은 plan의 값을
  `VacayMonthCard`에 넘긴다.
- `client/src/components/Vacay/VacayMonthCard.tsx`는 `0`이면 일요일,
  `1`이면 월요일 기준으로 header와 빈 cell을 함께 재정렬한다.
- `f3239520`의 도입 목적도 전역 설정이 아니라 configurable week start in
  Vacay였다.

### 공유 날짜 선택기에는 연결점이 없다

- `client/src/types.ts`의 사용자 `Settings`와
  `client/src/store/settingsStore.ts`의 `DEFAULT_SETTINGS`에 주 시작 key가 없다.
- `client/src/components/shared/CustomDateTimePicker.tsx`의
  `CustomDatePickerProps`에는 week-start 입력이 없고 settings store도 읽지 않는다.
- 같은 파일의 `(getWeekday(...) + 6) % 7` 및 2024-01-01 기준 header 생성은
  월요일 시작을 고정한다.
- 여행 생성·수정의 `TripFormModal`과 일반 예약의 `ReservationModal`은 이 공용
  picker를 사용한다. Todo와 Budget도 같은 영향 범위다.
- Journey는 `client/src/components/Journey/JourneyDetailPageDatePicker.tsx`에서
  별도로 월요일 시작과 `Mo`부터 `Su`까지의 영문 header를 고정한다.

`TransportModal` 자체는 날짜 달력 대신 여행 day를 고르는 select를 사용한다.
교통 화면에서 달력을 본 경우 일반 reservation flow 또는 인접 일정 입력 surface일
가능성이 높다. 실제 수정 전에는 화면 경로를 한 번 재현해 consumer를 확정한다.

## 현재 contract와 사용자 영향

| Surface            | 현재 소유 값             | 현재 시작 요일 | Vacay 설정 영향 |
| ------------------ | ------------------------ | -------------- | --------------- |
| Vacay 월 달력      | `vacay_plans.week_start` | plan별 일/월   | 있음            |
| 여행 생성·수정     | 없음                     | 월요일 고정    | 없음            |
| 일반 일정/예약     | 없음                     | 월요일 고정    | 없음            |
| Todo/Budget 날짜   | 없음                     | 월요일 고정    | 없음            |
| Journey 날짜 선택  | 없음                     | 월요일 고정    | 없음            |
| Transport day 선택 | trip day 목록            | 달력 아님      | 해당 없음       |

확인한 코드·focused test에서는 저장 실패나 권한 오류로 사용자 선택이 사라지는
경로가 드러나지 않았다. 문제는 Vacay 전용 control의 이름·위치가 범위를 충분히
설명하지 않는 점과, 전역 설정이 아직 없다는 점이다.

## 최소 개선안

### 결정: 사용자 전역 설정을 새로 둔다

사용자 `Settings`에 optional `calendar_week_start: 0 | 1`을 추가하고 기존 generic
settings 저장 경로를 사용한다. 새 DB column이나 migration은 만들지 않는다.
설정 control은 Vacay 안이 아니라 Settings의 Display 또는 Language & Region 성격의
영역에 둔다.

같은 변경에서 `VacaySettings`의 plan용 주 시작 control은 제거하거나 전역 설정으로
이동했음을 명시하는 link로 대체한다. 전역 값이 기존 plan 값보다 우선하는데 두
control을 모두 편집 가능하게 남기면 Vacay 버튼이 눌려도 화면이 바뀌지 않는 새로운
precedence UX 오류가 생긴다. `vacay_plans.week_start` column과 읽기 fallback만 legacy
호환용으로 유지한다.

적용 우선순위는 다음처럼 명시한다.

1. 전역 `calendar_week_start`를 사용자가 명시했으면 위 영향 범위의 날짜 picker에
   적용한다.
2. Vacay는 전역 값이 없을 때 기존 `vacay_plans.week_start`를 compatibility
   fallback으로 사용한다.
3. 둘 다 없으면 기존 동작과 호환되도록 월요일을 사용한다.

공용 `CustomDatePicker`와 별도 Journey picker가 같은 순수 weekday-order helper를
사용하게 한다. `CustomTimePicker`가 `settings.time_format`을 직접 읽어 모든
consumer에 반영하는 현재 패턴이 가장 가까운 참고 구조다.

### 하지 않을 것

- 공용 picker를 임의의 `vacay_plans.week_start`에 직접 연결하지 않는다. Vacay가
  비활성·미로딩 상태일 수 있고 어느 plan의 값을 쓸지도 정의되지 않는다.
- 기존 plan 값을 자동으로 사용자 전역 값으로 이관하지 않는다. 공유 plan 값은
  사용자 개인 선호라고 단정할 수 없다.
- locale/브라우저 지역에서 첫 요일을 자동 추론하는 기능은 이번 최소 변경에 넣지
  않는다.
- 모든 달력 component를 한 번에 재작성하거나 새 date library를 추가하지 않는다.

## TDD와 수용 기준

구현 전에 다음 RED contract를 먼저 고정한다.

1. 기본값과 명시적 Monday에서 공용 picker의 기존 Mon–Sun 순서가 유지된다.
2. Sunday 설정에서 공용 picker header가 Sun–Sat이고 2026-03-01이 첫 열에 온다.
3. 설정 저장 성공·실패가 기존 optimistic settings contract를 따른다.
4. Trip create/edit와 Reservation consumer가 같은 설정을 반영한다.
5. Journey의 header와 cell offset도 같은 설정을 반영한다.
6. Vacay는 명시적 전역 값을 우선하고, 미설정 사용자는 기존 plan 값으로 동작한다.
7. Vacay에 서로 충돌하는 두 editable control이 남지 않는다.
8. 390px와 1440px에서 control, picker overflow, keyboard/focus를 확인한다.

현재 조사에서 다음 baseline을 통과했다.

```text
npm run test --workspace=client -- --run \
  src/components/Vacay/VacayMonthCard.test.tsx \
  src/components/shared/CustomDateTimePicker.test.tsx

2 files, 39 tests passed
```

이 결과는 기존 Vacay plan 설정과 공용 picker의 현재 동작을 검증할 뿐, 아직 존재하지
않는 전역 Sunday contract를 검증한 것은 아니다.

## Change lane과 공식 기여 조건

이 기능은 특정 도메인·브랜드에 종속되지 않으므로 장기 lane은
`upstream-contrib` 후보다. 다만 공식
[issue #1078](https://github.com/liketrek/TREK/issues/1078)에서는 Journey를 기존
picker/Vacay와 일치하도록 월요일 시작으로 맞추는 방향이 완료됐다. 전역 선택 기능은
그 issue의 단순 누락 수정이 아니라 새로운 제품 contract다.

따라서 개인 포크에서 먼저 검증하더라도 공식 제출 전에는 다음을 지킨다.

1. TOM의 외부 게시 승인과 Discord `#github-pr` 범위 승인을 받는다.
2. 최신 `upstream/dev`에서 중복 issue/PR과 설정 schema를 다시 확인한다.
3. 전역 preference, 공용 picker, Journey, Vacay fallback만 한 PR에 넣고 다른 Vacay
   correctness 또는 UI cleanup을 섞지 않는다.
4. 포크 commit을 cherry-pick하지 않고 최신 공식 owning path에 최소 구현한다.
5. 공식 release에 수용된 뒤 동등성 회귀를 통과할 때만 포크 patch를 제거한다.

현재 publication hold에서는 Discord, 공식 issue, branch push와 PR을 만들지 않는다.
