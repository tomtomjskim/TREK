# Fork-Optional Sonar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Sonar가 없는 개인 fork의 core CI를 정상화하면서 fork 전용 Sonar를 나중에 명시적으로 탈부착할 수 있게 한다.

**Architecture:** 기존 coverage jobs와 artifact는 한 workflow에 유지한다. 마지막 scan job만 repository enable variable로 gate하고, project identity를 fork repository variables로 주입하며 활성 상태의 설정 누락은 preflight에서 실패시킨다.

**Tech Stack:** GitHub Actions YAML, SonarScanner properties, Node.js built-in test, Markdown

---

### Task 1: Fork CI provider contract를 RED로 고정

**Files:**

- Create: `scripts/ci-workflow-contract.test.mjs`
- Modify: `.github/workflows/test.yml`

**Step 1: Write the failing test**

Node built-in test로 다음을 assert한다.

- main workflow 이름이 Sonar를 core success 조건처럼 표시하지 않는다.
- scan job이 `vars.SONAR_ENABLED == 'true'`와 same-repository event를 모두 요구한다.
- enabled 상태에서 token/project key/organization 누락을 검사하는 preflight가 있다.
- scan action은 `SONAR_PROJECT_KEY`와 `SONAR_ORGANIZATION` repository variable을 사용한다.
- `sonar-project.properties`와 fork README에 `liketrek_TREK`/`sonar.organization=liketrek`가 없다.

**Step 2: Run test to verify RED**

Run: `node --test scripts/ci-workflow-contract.test.mjs`

Expected: FAIL because the workflow has no `SONAR_ENABLED` gate and still hard-codes upstream identity.

**Step 3: Attach the test to cheap CI preflight**

`plugin-facts` job에서 dependency install 전에 `node --test scripts/ci-workflow-contract.test.mjs`를
실행한다.

### Task 2: 최소 optional-provider 구현

**Files:**

- Modify: `.github/workflows/test.yml`
- Modify: `sonar-project.properties`
- Modify: `README.md`

**Step 1: Implement minimal workflow gate**

- workflow 이름/주석을 core tests + optional Sonar 의미로 바꾼다.
- `scan`을 `Optional Sonar Scan`으로 표시하고 enable variable + same-repo 조건을 둔다.
- scan action 전에 세 설정의 non-empty 여부를 검사하되 secret은 출력하지 않는다.
- scanner args에 project key/organization repository variable을 전달한다.

**Step 2: Remove upstream identity**

`sonar-project.properties`의 upstream project key/organization과 README badge를 제거한다.
나머지 source/test/coverage 범위는 유지한다.

**Step 3: Run test to verify GREEN**

Run: `node --test scripts/ci-workflow-contract.test.mjs`

Expected: PASS.

### Task 3: 문서와 정적 검증

**Files:**

- Modify: `docs/README.md`
- Modify: `docs/upstream/README.md`
- Modify: `docs/upstream/fork-extension-manifest.md`
- Modify: `docs/plans/2026-09-04-upstream-v4.2.0-integration-evidence.md`

**Step 1: Document activation and retirement**

Sonar를 `instance-only provider adapter`로 기록하고 disabled/enabled/fail-closed 상태, 필요한
repository settings, upstream sync 때 재적용할 test를 명시한다.

**Step 2: Run static validation**

Run:

```bash
node --test scripts/ci-workflow-contract.test.mjs
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/test.yml'))"
git diff --check
```

Expected: all exit 0.

**Step 3: Commit**

```bash
git add .github/workflows/test.yml sonar-project.properties README.md scripts/ci-workflow-contract.test.mjs docs/
git commit -m "ci(fork): make Sonar an optional provider"
```

### Task 4: Fork remote validation and landing

**Step 1: Push the isolated branch**

Run: `git push -u origin ci/optional-sonar`

**Step 2: Observe Actions**

Expected: core jobs pass; `Optional Sonar Scan` is skipped while `SONAR_ENABLED` is absent or false.

**Step 3: Land after review**

Fast-forward fork `main`, push, set repository variable `SONAR_ENABLED=false`, and confirm the main
workflow conclusion without changing production deployment.

**Step 4: Record evidence**

Update the release evidence and generated personal wiki with run ID, job conclusions, rollback
commit and the explicit disabled state. Regenerate and validate wiki metadata.
