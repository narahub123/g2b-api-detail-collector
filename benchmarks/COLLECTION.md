# 공고 상세 수집 성능 측정

첫 측정은 공고 3건의 상세 수집·구조화만 대상으로 합니다. 전체 수동/자동 수집, DB 저장, 관련 공고 확장, PDF 추출은 실행하지 않습니다. 측정 문맥이 없으면 기존 수집에서는 기록하지 않습니다.

## 대상 준비

프로젝트 루트에서 실제 날짜를 명시합니다. `.env.local`의 G2B_SERVICE_KEY가 필요합니다. 목록 API 응답은 변경하지 않고 중복 없는 공고 3건을 확보하면 순회를 종료합니다. 날짜별 첫 페이지 선조회는 기존 API 함수의 동작대로 실행될 수 있습니다.

```powershell
node --env-file-if-exists=.env.local --import tsx scripts/benchmark-collection.ts --prepare --start=2026-10-29 --end=2026-10-29 --out=benchmarks/results/sample-preparation
```

대상이 부족하면 측정을 시작하지 않습니다. 준비 디렉터리에는 manifest.json이 생성됩니다. 출력 디렉터리가 이미 있으면 중단하며 덮어쓰지 않습니다.

## 측정

Chrome과 필요 시 G2B_CHROME_PATH가 필요합니다. 첫 시험은 1회, 기준 측정은 동일한 manifest로 3회를 사용합니다.

```powershell
node --env-file-if-exists=.env.local --import tsx scripts/benchmark-collection.ts --manifest=benchmarks/results/sample-preparation/manifest.json --iterations=1 --out=benchmarks/results/sample-smoke
node --env-file-if-exists=.env.local --import tsx scripts/benchmark-collection.ts --manifest=benchmarks/results/sample-preparation/manifest.json --iterations=3 --out=benchmarks/results/sample-before
```

반복마다 events.jsonl(원시 구간), summary.json(공고별 성공/실패 및 작업 집계), report.md(요약), snapshot.json(실제 결과)이 생성됩니다. 실패한 공고를 재시도하거나 다른 공고로 대체하지 않습니다. 발견한 관련 키는 결과에만 남습니다. 공고 내부 모달·표 수집은 유지합니다.

## 해석과 제한

- durationMs는 단조 증가 시계 기준입니다. spanId/parentSpanId로 중첩을 구분하며 inclusive 시간을 모두 더하면 안 됩니다. 비동기 첨부 응답 파싱은 다른 작업과 겹칠 수 있습니다.
- 모달 안정화·표 전환의 개별 호출 횟수와 시간이 기록됩니다. `modal.wait-settled`의 details에는 후보 ID·레이블·값·탐색 깊이·부모 모달과 실제 대기 결과(outcome), 값이 있는 셀 수가 남습니다. `modal.observation`에는 대기 후 새 모달 발견 여부(newModal)가 남습니다. 공고 키·부모 모달·후보 ID로 두 기록을 연결합니다. 함수의 succeeded와 실제 settled/timeout은 다른 의미입니다. 표별 행 수는 snapshot에서 확인합니다.
- 이벤트 버퍼는 반복당 최대 100,000건입니다. dropped 또는 outputFailed가 있으면 해당 원시 기록은 불완전합니다. 수집 실패·기록 누락 시 종료 코드는 1입니다.
- 실패 원문은 추가 저장하지 않습니다. 기존 수집 결과의 warnings/modalDiscovery와 실패 구간의 작업명으로 판단합니다. 오류 진단 보강 도구가 아닙니다.
- 프로세스를 강제 종료하면 메모리의 미저장 기록은 유실될 수 있습니다. summary가 없거나 수집 실패가 있는 반복은 정상 완료 기준 비교에서 제외합니다.
- snapshot에는 실제 공고 자료가 있습니다. 결과는 Git에서 제외되는 benchmarks/results 아래 보관하고 외부 공유 전 내용을 확인합니다.
- 실제 사이트의 데이터 변화·망 상태가 영향을 줍니다. 시각 필드와 내용 변화는 구분하여 비교합니다. 이 값으로 전체 수집 처리량이나 DB 성능을 판단하지 않습니다.

2단계에서는 테스트 데이터로 동작을 검증합니다. 실제 나라장터 대상 준비·기준 측정은 별도 3단계에서 실행합니다.
