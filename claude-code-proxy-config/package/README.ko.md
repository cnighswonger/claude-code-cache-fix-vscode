# claude-code-cache-fix

[English](./README.md) | [中文](./README.zh.md) | 한국어

[Claude Code](https://github.com/anthropics/claude-code)에서 세션 재개 시 **최대 20배 비용 증가**를 유발하는 프롬프트 캐시 회귀 버그를 수정하고, 자동 컨텍스트 열화를 모니터링합니다. v2.1.107까지 확인 완료.

## 보안 모델

> **이 인터셉터는 `globalThis.fetch`를 패치합니다.** 설계상 Claude Code 프로세스의 모든 API 요청·응답에 대한 읽기/쓰기 접근 권한을 가집니다. 이는 fetch 인터셉터, 프록시, 게이트웨이 등 이 방식에서 본질적으로 발생하는 것입니다.

**하는 것:** 캐시 버그 수정을 위해 요청 구조(블록 순서, 핑거프린트, TTL, git-status)를 수정합니다. 모니터링을 위해 응답 헤더와 SSE 사용량 데이터를 읽습니다.

**하지 않는 것:** 인터셉터에서 네트워크 호출을 하지 않습니다. 모든 텔레메트리는 `~/.claude/` 아래 로컬 파일에 기록됩니다. [claude-code-meter](https://github.com/cnighswonger/claude-code-meter) 공유에 명시적으로 동의하지 않는 한 데이터가 외부로 전송되지 않습니다.

**공급망:** 단일 비축소 파일(`preload.mjs`, ~1,700줄). 의존성 1개(`zod`, 테스트 스키마 검증용). 설치 전 코드를 직접 검토하십시오. npm provenance로 각 버전이 소스 커밋에 연결됩니다.

**독립 감사:** @TheAuditorTool에 의해 ["LEGITIMATE TOOL"로 평가](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605) (2026-04-14).

## 문제점

Claude Code에서 `--resume` 또는 `/resume`를 사용하면 프롬프트 캐시가 자동으로 깨집니다. 캐시된 토큰을 읽는 대신(저렴) 매 턴마다 처음부터 재구축합니다(고비용). 시간당 약 $0.50이어야 할 세션이 아무런 표시 없이 $5-10/시간까지 치솟을 수 있습니다.

세 가지 버그가 원인입니다:

1. **블록 분산(Partial block scatter)** — 스킬 목록, MCP 서버, 지연 도구, 훅 등 첨부 블록이 `messages[0]`에 있어야 하지만, 세션 재개 시 이후 메시지로 이동하여 캐시 접두사가 변경됩니다.

2. **핑거프린트 불안정(Fingerprint instability)** — `cc_version` 핑거프린트(예: `2.1.92.a3f`)가 메타/첨부 블록을 포함한 `messages[0]` 내용으로 계산됩니다. 블록이 이동하면 핑거프린트가 바뀌고, 시스템 프롬프트가 바뀌고, 캐시가 무효화됩니다.

3. **도구 정의 순서 비결정적(Non-deterministic tool ordering)** — 도구 정의가 턴 간에 다른 순서로 도착할 수 있어 요청 바이트가 변경되고 캐시 키가 무효화됩니다.

또한 Read 도구로 읽은 이미지가 base64로 대화 기록에 저장되어 이후 모든 API 호출에 함께 전송되며, 토큰 비용이 자동으로 누적됩니다.

## 설치

Node.js >= 18 필요, Claude Code가 npm으로 설치되어 있어야 합니다(독립 바이너리 불가).

```bash
npm install -g claude-code-cache-fix
```

## 사용법

Node.js 프리로드 모듈로 동작하며, API 요청이 전송되기 전에 인터셉트합니다.

### 방법 A: 래퍼 스크립트 (권장)

래퍼 스크립트(예: `~/bin/claude-fixed`)를 생성합니다:

```bash
#!/bin/bash
NPM_GLOBAL_ROOT="$(npm root -g 2>/dev/null)"

CLAUDE_NPM_CLI="$NPM_GLOBAL_ROOT/@anthropic-ai/claude-code/cli.js"
CACHE_FIX="$NPM_GLOBAL_ROOT/claude-code-cache-fix/preload.mjs"

if [ ! -f "$CLAUDE_NPM_CLI" ]; then
  echo "Error: Claude Code npm package not found at $CLAUDE_NPM_CLI" >&2
  echo "Install with: npm install -g @anthropic-ai/claude-code" >&2
  exit 1
fi

if [ ! -f "$CACHE_FIX" ]; then
  echo "Error: claude-code-cache-fix not found at $CACHE_FIX" >&2
  echo "Install with: npm install -g claude-code-cache-fix" >&2
  exit 1
fi

exec env NODE_OPTIONS="--import $CACHE_FIX" node "$CLAUDE_NPM_CLI" "$@"
```

```bash
chmod +x ~/bin/claude-fixed
```

npm 글로벌 경로가 다른 경우 `npm root -g`로 확인하여 조정하십시오.

### 방법 B: 셸 별칭

```bash
alias claude='NODE_OPTIONS="--import claude-code-cache-fix" node "$(npm root -g)/@anthropic-ai/claude-code/cli.js"'
```

### 방법 C: 직접 호출

```bash
NODE_OPTIONS="--import claude-code-cache-fix" claude
```

> **참고**: `claude`가 npm/Node 설치를 가리킬 때만 동작합니다. 독립 바이너리는 Node.js 프리로드를 우회하는 다른 실행 경로를 사용합니다.

### Windows 사용자

Windows에서는 `NODE_OPTIONS="--import ..."` 방식이 Linux/macOS와 동일하게 동작하지 않습니다. 포함된 `claude-fixed.bat` 래퍼를 사용하십시오:

1. 두 패키지를 글로벌 설치합니다:
   ```bat
   npm install -g claude-code-cache-fix
   npm install -g @anthropic-ai/claude-code
   ```

2. `claude-fixed.bat`를 PATH에 있는 디렉토리로 복사합니다(예: `C:\Users\<이름>\bin\`):
   ```bat
   copy "%NPM_ROOT%\claude-code-cache-fix\claude-fixed.bat" C:\Users\%USERNAME%\bin\
   ```
   또는 npm 글로벌 루트(`npm root -g`)에서 직접 파일을 찾으십시오.

3. 인터셉터가 활성화된 상태로 Claude Code를 실행합니다:
   ```bat
   claude-fixed [claude 인수...]
   ```

## VS Code 확장

### 방법 A: VSIX 확장 (권장)

1. 인터셉터 설치: `npm install -g claude-code-cache-fix`
2. [GitHub Releases](https://github.com/cnighswonger/claude-code-cache-fix-vscode/releases/latest)에서 VSIX 다운로드
3. 설치: `code --install-extension claude-code-cache-fix-0.1.0.vsix`
   (또는 VS Code: 확장 → `...` 메뉴 → "VSIX에서 설치...")
4. 활성 Claude Code 세션 재시작

확장이 활성화 시 `claudeCode.claudeProcessWrapper`를 자동 설정합니다. 수동 설정이 필요 없으며 Windows, macOS, Linux에서 동작합니다.

### 알려진 제한 (VS Code)

- **핑거프린트 수정 자동 비활성화**: VS Code 확장은 CLI와 다르게 `messages[0]`을 구성하여 핑거프린트 안전 검사가 실패합니다. `CACHE_FIX_SKIP_FINGERPRINT=1` 환경변수로 우회하십시오. 다른 모든 수정(재배치, 도구 정렬, TTL, /clear 아티팩트 제거)은 정상 동작합니다.

## 동작 원리

모듈은 Claude Code가 `/v1/messages`에 API 호출하기 전에 `globalThis.fetch`를 인터셉트합니다. 각 호출에서:

1. 모든 사용자 메시지에서 재배치 대상 첨부 블록(스킬, MCP, 지연 도구, 훅)을 스캔하여 최신 버전을 `messages[0]`으로 이동합니다.
2. 도구 정의를 이름 알파벳순으로 정렬하여 결정적 순서를 보장합니다.
3. 메타/첨부 블록이 아닌 실제 사용자 메시지 텍스트로 `cc_version` 핑거프린트를 재계산합니다.

모든 수정은 멱등적입니다 — 수정이 필요 없으면 요청이 그대로 전달됩니다.

## 이미지 제거

Read 도구로 읽은 이미지는 base64로 인코딩되어 대화 기록의 `tool_result` 블록에 저장됩니다. 압축될 때까지 **이후 모든 API 호출에** 함께 전송됩니다. 500KB 이미지 하나가 턴당 약 62,500 토큰의 추가 비용을 발생시킵니다.

오래된 도구 결과에서 이미지를 제거하려면:

```bash
export CACHE_FIX_IMAGE_KEEP_LAST=3
```

최근 3개 사용자 메시지의 이미지를 유지하고 이전 것은 텍스트 자리 표시자로 대체합니다. `tool_result` 블록(Read 도구 출력)의 이미지만 대상이며, 사용자가 직접 붙여넣은 이미지는 영향받지 않습니다.

`0`(기본값)으로 설정하면 비활성화됩니다.

## 시스템 프롬프트 재작성 (선택)

Claude Code의 `# Output efficiency` 시스템 프롬프트 섹션을 요청 전에 재작성할 수 있습니다.

이 기능은 **선택적**이며 **기본 비활성화**입니다. `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT`를 설정하지 않으면 아무것도 변경되지 않습니다.

```bash
export CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT=$'# Output efficiency\n\n...'
```

## 모니터링 기능

인터셉터에는 커뮤니티에서 발견한 추가 문제에 대한 모니터링이 포함됩니다:

### 마이크로컴팩트 / 예산 집행

Claude Code는 서버 제어 메커니즘(GrowthBook 플래그)을 통해 이전 도구 결과를 `[Old tool result content cleared]`로 자동 대체합니다. 200,000자 총 한도와 도구별 한도(Bash: 30K, Grep: 20K)가 알림 없이 이전 결과를 잘라냅니다.

### 가상 속도 제한기

클라이언트가 실제 API 호출 없이 합성 "Rate limit reached" 오류를 생성할 수 있으며, `"model": "<synthetic>"`으로 식별됩니다.

### GrowthBook 플래그 덤프

첫 API 호출 시 `~/.claude.json`을 읽어 비용/캐시 관련 서버 제어 플래그의 현재 상태를 기록합니다.

### 쿼터 추적

응답 헤더에서 `anthropic-ratelimit-unified-5h-utilization`과 `7d-utilization`을 파싱하여 `~/.claude/quota-status.json`에 저장합니다.

### 피크 시간 감지

Anthropic은 평일 피크 시간(UTC 13:00-19:00, 월-금)에 쿼터 소모 속도를 높입니다. 인터셉터가 피크 기간을 감지하여 `quota-status.json`에 `peak_hour: true/false`를 기록합니다.

### 사용량 텔레메트리 및 비용 리포트

API 호출당 사용량 데이터를 `~/.claude/usage.jsonl`에 기록합니다. 내장 비용 리포트 도구로 분석할 수 있습니다:

```bash
node tools/cost-report.mjs                    # 오늘 비용
node tools/cost-report.mjs --date 2026-04-08  # 특정 날짜
node tools/cost-report.mjs --since 2h         # 최근 2시간
node tools/cost-report.mjs --admin-key <key>  # Admin API 교차 검증
```

## 상태 표시줄

인터셉터는 매 API 호출마다 `~/.claude/quota-status.json`에 쿼터 상태를 기록합니다. 포함된 `tools/quota-statusline.sh` 스크립트로 Claude Code에 실시간 상태를 표시할 수 있습니다:

- **Q5h %** (소진율)
- **Q7d %** (소진율)
- **TTL 티어** — 정상 시 `TTL:1h`, **서버 다운그레이드 시 빨간색 `TTL:5m`**
- **PEAK** — 피크 시간 시 노란색 표시
- **캐시 히트율 %**

### 설정

```bash
mkdir -p ~/.claude/hooks
cp "$(npm root -g)/claude-code-cache-fix/tools/quota-statusline.sh" ~/.claude/hooks/
chmod +x ~/.claude/hooks/quota-statusline.sh
```

`~/.claude/settings.json`에 추가:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/hooks/quota-statusline.sh"
  }
}
```

### 권장: git-status 주입 비활성화

Claude Code는 매 호출마다 `git status` 출력을 시스템 프롬프트에 주입합니다. 파일 편집 시마다 git 상태가 바뀌어 전체 접두사 캐시가 무효화됩니다. 비활성화하면 호출당 약 1,800 토큰을 절약하고 시스템 프롬프트를 안정화합니다:

```bash
export CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1
```

또는 `~/.claude/settings.json`에 `"includeGitInstructions": false`를 추가하십시오.

## 디버그 모드

```bash
CACHE_FIX_DEBUG=1 claude-fixed
```

로그는 `~/.claude/cache-fix-debug.log`에 기록됩니다. 주요 확인 항목:

- `APPLIED: resume message relocation` — 블록 분산이 감지되어 수정됨
- `APPLIED: tool order stabilization` — 도구가 재정렬됨
- `APPLIED: fingerprint stabilized from XXX to YYY` — 핑거프린트가 보정됨
- `MICROCOMPACT: N/M tool results cleared` — 마이크로컴팩트 열화 감지
- `FALSE RATE LIMIT: synthetic model detected` — 클라이언트 측 가상 속도 제한 감지
- `CACHE TTL: tier=1h create=N read=N hit=N%` — TTL 티어 및 캐시 히트율
- `PEAK HOUR: weekday 13:00-19:00 UTC` — Anthropic 피크 시간 스로틀링 활성

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `CACHE_FIX_DEBUG` | `0` | 디버그 로그 활성화 |
| `CACHE_FIX_PREFIXDIFF` | `0` | 접두사 스냅숏 비교 활성화 |
| `CACHE_FIX_IMAGE_KEEP_LAST` | `0` | 최근 N개 사용자 메시지의 이미지 유지 (0 = 비활성화) |
| `CACHE_FIX_USAGE_LOG` | `~/.claude/usage.jsonl` | 호출별 사용량 텔레메트리 로그 경로 |
| `CACHE_FIX_DISABLED` | `0` | 모든 버그 수정 비활성화, 모니터링은 유지 |
| `CACHE_FIX_SKIP_RELOCATE` | `0` | 블록 재배치 수정 건너뛰기 |
| `CACHE_FIX_SKIP_FINGERPRINT` | `0` | 핑거프린트 안정화 건너뛰기 |
| `CACHE_FIX_SKIP_TOOL_SORT` | `0` | 도구 정렬 안정화 건너뛰기 |
| `CACHE_FIX_SKIP_TTL` | `0` | TTL 주입 건너뛰기 |
| `CACHE_FIX_STRIP_GIT_STATUS` | `0` | 접두사 안정화를 위해 git-status 제거 |
| `CACHE_FIX_TTL_MAIN` | `1h` | 메인 스레드 요청 TTL: `1h`, `5m`, 또는 `none` |
| `CACHE_FIX_TTL_SUBAGENT` | `1h` | 서브에이전트 요청 TTL: `1h`, `5m`, 또는 `none` |

## 제한 사항

- **npm 설치만 지원** — 독립 Claude Code 바이너리는 Zig 수준 증명을 사용하여 Node.js를 우회합니다. 이 수정은 npm 패키지(`npm install -g @anthropic-ai/claude-code`)에서만 동작합니다.
- **초과 TTL 다운그레이드** — 5시간 쿼터 100% 초과 시 서버가 TTL을 1h에서 5m으로 강제 다운그레이드합니다. 서버 측 결정이므로 클라이언트에서 수정할 수 없습니다.
- **마이크로컴팩트 방지 불가** — 모니터링은 컨텍스트 열화를 감지할 수 있지만 방지할 수는 없습니다. GrowthBook 플래그를 통한 서버 제어이며 클라이언트 비활성화 옵션이 없습니다.
- **버전 결합** — 핑거프린트 salt와 블록 감지 휴리스틱은 Claude Code 내부 구현에서 파생됩니다. 대규모 리팩토링 시 이 패키지 업데이트가 필요할 수 있습니다.

## 관련 이슈

- [#34629](https://github.com/anthropics/claude-code/issues/34629) — 세션 재개 캐시 회귀 최초 보고
- [#40524](https://github.com/anthropics/claude-code/issues/40524) — 세션 내 핑거프린트 무효화, 이미지 지속
- [#42052](https://github.com/anthropics/claude-code/issues/42052) — 커뮤니티 인터셉터 개발, TTL 다운그레이드 발견
- [#44045](https://github.com/anthropics/claude-code/issues/44045) — SDK 수준 재현 및 토큰 측정
- [#32508](https://github.com/anthropics/claude-code/issues/32508) — `Output efficiency` 시스템 프롬프트 변경 커뮤니티 논의

## 관련 리서치

- **[@ArkNill/claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** — 프록시 기반 체계적 분석: 마이크로컴팩트, 예산 집행, 가상 속도 제한기 등 11개 버그 + 30,477건 요청 데이터셋. v1.1.0 모니터링 기능은 이 리서치에 기반합니다.
- **[@Renvect/X-Ray-Claude-Code-Interceptor](https://github.com/Renvect/X-Ray-Claude-Code-Interceptor)** — 실시간 대시보드가 있는 진단용 HTTPS 프록시
- **[@fgrosswig/claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard)** — 셀프 호스팅 포렌식 대시보드, SSE 실시간 모니터링

## 기여자

- **[@VictorSun92](https://github.com/VictorSun92)** — v2.1.88 최초 monkey-patch 수정, 부분 블록 분산 식별
- **[@bilby91](https://github.com/bilby91)** ([Crunchloop DAP](https://dap.crunchloop.ai)) — 프로덕션 환경 검증, 도구 정렬 흔들림 발견
- **[@jmarianski](https://github.com/jmarianski)** — MITM 프록시 캡처 및 Ghidra 역공학을 통한 근본 원인 분석
- **[@cnighswonger](https://github.com/cnighswonger)** — 핑거프린트 안정화, 모니터링 기능, 패키지 관리자
- **[@ArkNill](https://github.com/ArkNill)** — 마이크로컴팩트 메커니즘 분석, GrowthBook 플래그 문서화, 가상 속도 제한기 식별
- **[@TomTheMenace](https://github.com/TomTheMenace)** — Windows `.bat` 래퍼, 최초 Windows 플랫폼 검증 (7.5시간/536호출, 98.4% 캐시 히트율)
- **[@fgrosswig](https://github.com/fgrosswig)** — 포렌식 대시보드, 비용 팩터 메트릭 방법론
- **[@JEONG-JIWOO](https://github.com/JEONG-JIWOO)** — VS Code 확장 조사, `claudeCode.claudeProcessWrapper` 통합 경로 발견

## 라이선스

[MIT](LICENSE)
