# 나라장터 용역 입찰공고 수집기

공고 게시일 범위를 지정해 조달청 나라장터 용역 입찰공고 API를 조회하고, 공개 상세 페이지를 브라우저로 읽어 Neon PostgreSQL에 저장하는 Next.js 앱입니다. `/`에서 사용자 공고 목록을, `/bids/<공고 키>`에서 수집된 상세 정보를 확인할 수 있습니다. 검색과 필터링은 추후 추가할 예정입니다.

`/admin`에서는 공고 수집과 재수집을 관리합니다. 관리자 공고 상세(`/admin/bids/<공고 키>`)의 **수집 정보 비교** 링크를 열면 API 전체 항목과 상세 페이지의 필드·섹션·표를 함께 볼 수 있습니다. 클릭해서 열린 추가 화면의 정보는 팝업별 필드·표·본문으로 묶어 표시합니다. 모달 안에서 다시 연 화면은 원래 모달의 이름도 함께 표시합니다. 이전 수집 자료에 해당 정보가 없으면 빈 상태를 표시합니다.

`/admin/collections`에서 수동·자동·재수집 작업 이력을 조회하고, 작업을 열어 API·상세·모달·첨부·DB 단계의 실패와 경고를 확인할 수 있습니다. 작업별 진단은 기존 `collection_jobs.state`의 `diagnostics`에 저장됩니다. 개별 기록은 처음 500건을 표시하고, 이후 기록은 심각도·단계·작업·오류 코드·숫자를 정규화한 메시지별로 집계합니다. 각 유형의 대표 기록은 남습니다. 이전 작업의 `errors`는 기존 오류로 표시합니다.

상세 페이지에서 정보를 보여 주는 클릭 요소와 열린 모달 안의 클릭 요소를 탐색합니다. 페이지 이동, 다운로드, 저장·제출 같은 상태 변경 요소는 탐색하지 않습니다. 공지사항 등 읽기 전용 모달은 현재 공고의 상세 수집 자료에 저장합니다.

## 로컬 PDF 텍스트 추출

관리자 공고 상세에서 직접 첨부 PDF를 **파일별 아코디언**으로 확인하고 추출·재추출을 요청합니다. PDF.js `6.4.299 / reading-order-v1`을 사용하며 AI·OCR·HWP·HWPX·모달 첨부는 처리하지 않습니다. 원본 PDF는 처리 중에만 임시 저장합니다. 기존 수집과 Actions 설정은 변경하지 않았으며 자동 실행은 아래 PDF 자동화 적용 절차를 마친 뒤 활성화합니다.

1. `.env.local`에 `DATABASE_URL`과 아래 설정을 준비합니다. 토큰은 웹 서버와 작업기가 공유하는 32자 이상 값입니다.

   ```dotenv
   PDF_EXTRACTION_ENABLED=true
   PDF_WORKER_ENABLED=true
   PDF_WORKER_URL=http://127.0.0.1:8788
   PDF_WORKER_TOKEN=<32자 이상의 임의 토큰>
   ```

2. 운영 스키마는 `npm run db:migrate`로 준비합니다. 이 명령은 종료된 PoC 원본 테이블도 제거하며, 운영 테이블의 이력·본문은 유지합니다.
3. `docker compose --env-file .env.local -f compose.pdf-worker.yml up -d --build`로 로컬 작업기를 시작합니다.
4. `npm run dev -- --hostname 127.0.0.1`로 웹 앱을 실행합니다. 기존 개발 서버는 환경변수 변경을 반영했는지 확인합니다.
5. `/admin/bids/<공고 키>`의 **PDF 텍스트 추출**에서 파일을 펼쳐 **추출 요청 / 다시 추출 / 재추출**을 누릅니다.

목록은 본문 없이 파일 상태만 조회합니다. 파일을 처음 펼치면 해당 파일의 실행 이력 20개와 마지막 성공의 첫 페이지를 읽고, 페이지를 이동할 때 선택한 페이지만 조회합니다. 여러 파일을 동시에 펼칠 수 있으며 파일별 실행·페이지 선택을 유지합니다. 현재 첨부에서 사라진 문서는 이전 첨부 이력에 남습니다.

Docker가 꺼져 있어도 요청은 DB 대기열에 남습니다. 시작 또는 명시적 깨우기 1회에 manual 요청만 최대 3건·20분 처리합니다. 미래 재시도를 기다리거나 무한 폴링하지 않습니다. 다음 요청·작업기 시작 또는 CLI 배치가 남은 요청을 처리하며, 외부 PDF 보완 작업을 활성화하면 독립적으로 재평가합니다. 실패·텍스트 없음·중단은 이전 성공 본문을 덮어쓰지 않습니다.

관리자 화면의 **첨부파일 추출 이력** 카드(`/admin/document-extractions`)에서 전체 실행을 상태·문서 형식·파일명·공고 키·접수일로 검색합니다. 상세에서는 마지막 처리 단계·페이지 진행·재시도 흐름과 오류 기술 정보를 확인하고, 필요한 페이지 본문만 별도로 조회합니다. 날짜와 접수일 필터는 한국 시간 기준입니다. 수집 작업 이력도 같은 카드 컴포넌트로 이동합니다.

`0008-extraction-diagnostics.sql` 적용 이후의 실행부터 문서 형식·진행 정보·정제된 원본 오류를 저장합니다. 이전 기록은 보충하거나 삭제하지 않습니다. 오류 메시지·원인·스택에서 인증 정보와 연결 문자열을 제거하며 본문은 진단 로그에 포함하지 않습니다. 단계는 마지막 상태만 저장하므로 전체 이벤트 타임라인이나 프로세스 생존 여부를 뜻하지 않습니다. 현재 추출기는 PDF만 지원하며 다른 문서 형식은 추후 같은 이력 구조로 추가할 수 있습니다. 기존 설치에서도 마이그레이션과 작업기 이미지 재빌드가 필요합니다.

웹 기능은 기본 비활성화이고 로컬 개발에서만 허용합니다. production 모드에서는 항상 차단됩니다. 컨테이너 포트는 `127.0.0.1:8788`만 공개하며 토큰과 DB 연결 정보는 브라우저에 보내지 않습니다. 중지는 `docker compose --env-file .env.local -f compose.pdf-worker.yml stop`입니다.

추출은 50MiB·500페이지·5분, 컨테이너는 CPU 2개·메모리 4GiB로 제한합니다. 좌우 두 면은 왼쪽 이후 오른쪽 순서로, 별도 PDF 페이지는 원래 순서로 처리합니다. 테두리가 없거나 복잡한 표·세로쓰기 등은 정확도를 보증하지 않습니다. 참가 자격·제출 서류·기한은 원본과 대조하세요.

PoC 실행 코드와 원본 테이블은 제거했습니다. 기존 이관 이력은 운영 테이블에 `source=poc_import`로 유지합니다. 원본 테이블만 제거할 때는 `npm run db:retire:pdf-poc`를 사용합니다. 이 명령은 추가 이관 검증이나 백업 없이 삭제 SQL만 실행하며, 종속성이 있으면 CASCADE 없이 실패합니다. 기존 SQL 마이그레이션 파일은 변경 이력으로 보존합니다.

검증: `npx vitest run src/lib/documents src/components/DocumentPanel.test.tsx src/components/FormAccordion.test.tsx --pool=threads`. 실제 DB 검사는 `LIVE_DB_TEST=1`과 DB 환경변수를 설정해 `store.live.test.ts`, `queue.live.test.ts`, `retirement.live.test.ts`를 실행합니다. 검사 전용 스키마·자료는 종료 시 정리합니다.

## 기본 앱 시작

1. Node.js와 Google Chrome을 설치합니다.
2. `npm install`을 실행합니다.
3. [`.env.local`](.env.local)의 `G2B_SERVICE_KEY=` 뒤에 공공데이터포털에서 발급받은 나라장터 입찰공고정보서비스 인증키를 입력합니다. 일반 인증키와 URL 인코딩된 인증키를 모두 사용할 수 있습니다. `.env`도 사용할 수 있지만 `.env.local`에 같은 변수가 있으면 그 값이 우선합니다. 두 파일 모두 Git에서 제외됩니다.
4. `.env.local`에 Neon 연결 문자열을 `DATABASE_URL=`로 설정합니다.
5. `npm run db:migrate`로 DB 스키마를 적용합니다.
6. `npm run dev`를 실행하고 사용자 목록 `http://localhost:3000` 또는 관리자 화면 `http://localhost:3000/admin`을 엽니다.
7. 관리자 화면에서 **공고 게시일**의 시작일과 종료일을 선택해 `공고 수집 시작`을 누릅니다. 두 날짜 모두 조회 범위에 포함됩니다.

기존 공고를 다시 수집하려면 `/admin`의 저장 공고 목록에서 공고번호·차수 옆 체크박스로 한 건 또는 여러 건을 선택하고 **선택 공고 재수집**을 누릅니다. 정상 수집된 공고도 선택할 수 있으며 공고별 결과가 목록 위에 표시됩니다. 이 작업은 저장된 상세 페이지를 다시 읽으며 날짜 범위 API 조회나 관련 공고 자동 수집은 하지 않습니다.

이전 비교 주소 `/bids/<공고 키>/compare`와 이전 사용자 상세 주소 `/bids/<공고 키>/view`는 더 이상 제공하지 않습니다. 현재 관리자 경로와 수집 API에는 별도 접근 제한이 없습니다.

Chrome이 기본 설치 위치에 없으면 `.env.local`에 `G2B_CHROME_PATH=Chrome 실행 파일의 절대 경로`를 추가합니다.

## 증분 수집 명령

DB 스키마를 적용한 뒤 `npm run collect:incremental -- --start=2026-10-27T00:00:00Z`로 분 단위 증분 수집을 실행합니다. `--start`는 첫 실행의 UTC 조회 시작 시각이며, 이후에는 마지막으로 정상 완료한 작업의 조회 끝 시각부터 겹쳐 조회합니다. 검증할 때는 `--end=2026-10-27T05:00:00Z`처럼 종료 시각을 고정할 수 있습니다. 한 번에 최대 4시간을 처리하고 `continuation: true`를 출력하면 같은 명령을 다시 실행해 남은 구간을 처리합니다.

`/admin`의 **자동 수집 설정**에서 활성화 여부, 조회 시작 날짜와 시각, 주기 또는 하루 여러 예약 시각을 지정합니다. 화면 시각은 서울 기준입니다. 설정 후 `npm run collect:incremental -- --scheduled`를 호출하면 현재 시각에 예정된 작업 한 건만 선점해 실행합니다. 첫 실행은 활성화 직후가 아니라 다음 예약 시각에 시작합니다. 겹친 예약은 건너뛰고 다음 실행에서 마지막 정상 수집 시각부터 누락 구간을 조회합니다.

GitHub Actions의 [G2B collection](https://github.com/narahub123/g2b-api-detail-collector/actions/workflows/collect.yml) 워크플로는 5분마다 예약을 확인합니다. `DATABASE_URL`과 `G2B_SERVICE_KEY`는 저장소 Secrets에서 전달합니다. 수동 Actions 실행은 `start`와 선택적인 `end`에 UTC ISO 시각을 넣어 실제 API·상세·DB 연결을 검증할 수 있습니다. 검증 전에는 `G2B_SCHEDULE_ENABLED` 저장소 변수를 설정하지 않아 예약 이벤트가 수집을 시작하지 않습니다. 실제 검증 후 이 변수를 `true`로 설정해야 예약 실행이 시작됩니다. 공개 저장소에서 60일간 활동이 없으면 GitHub가 예약 워크플로를 비활성화할 수 있으므로 관리자 화면의 마지막 예약 시각과 Actions 기록을 확인하세요.

전체 조회가 실패하면 같은 구간을 즉시 한 번 더 조회합니다. 두 번 모두 실패하거나 실행이 중단되면 다음 실행에서 마지막 정상 완료 구간부터 다시 조회합니다. 상세 실패는 전체 순회 후 한 번, 다음 실행에서 한 번 더 시도하며 공고별 총 세 번 실패하면 자동 시도를 멈춥니다. 관리자 화면에서 선택 재수집은 계속 사용할 수 있습니다.

## 저장 위치

- Neon `notices`: 공고번호·차수별 API 항목, 상세 원문(JSONB), 분석용 요약 컬럼
- Neon `independent_details`, `notice_independent_refs`: 발주계획·사전규격·개찰·기타 독립 상세와 공고 참조
- Neon `notice_relations`: 직접 발견한 공고의 양방향 관계
- 공고 상세의 `baseAmountCaptures`, `changeNoticeCaptures`는 해당 공고 차수에 종속된 정보입니다. 분류되지 않은 모달은 `modalCaptures`에 남습니다.
- Neon `collection_jobs`, `collection_lock`: 수집 작업의 진행 상태·오류와 공통 실행 잠금.
- Neon `collection_notice_attempts`: 증분 수집 공고별 상세 시도 횟수와 실패·성공 상태. API 페이지 위치와 조회 구간은 `collection_jobs.state`에 남습니다.
- Neon `collection_automation`: 활성화 여부, 주기 또는 지정 시각, 시작점과 마지막 처리 예약 시각을 보존합니다.

테이블과 각 컬럼의 한국어 설명은 [`db/schema.sql`](db/schema.sql)의 PostgreSQL `COMMENT`로 관리합니다. `npm run db:migrate`를 다시 실행하면 기존 테이블의 설명도 갱신됩니다. `api`, `detail`, `payload`, `triggers`는 수집 원본의 구조가 달라질 수 있어 JSONB로 보존합니다.

공고 원본 번호는 `notices.notice_number`, 발주계획·사전규격 등 독립 상세의 문자열 식별자는 `independent_details.detail_key`와 `notice_independent_refs.detail_key`에 저장합니다. 기존 `number` 컬럼은 `npm run db:migrate` 실행 시 데이터 유지 방식으로 이름을 바꿉니다.

기관명 요약은 `notices.demand_agency`(수요기관)와 `notices.notice_agency`(공고기관)에 각각 저장합니다. 기존 `agency` 컬럼은 마이그레이션에서 제거하며 기존 공고의 새 요약 컬럼은 채우지 않습니다. 화면은 보관된 API·상세 원본에서 두 기관을 각각 읽고, 해당 공고를 재수집하면 새 요약 컬럼도 채웁니다. 변경된 앱을 실행하기 전에 `npm run db:migrate`를 적용하세요.

개찰결과상세 모달은 `입찰진행현황` 표에서 클릭한 행의 재입찰번호를 확인하면 `opening--공고키--재입찰번호`로 독립 저장하고 개찰 탭에 표시합니다. 모달 안에서 열린 하위 상세도 같은 독립 상세에 포함합니다. 재입찰번호를 확인하지 못하면 기존 공고 상세에 두고 경고를 기록합니다. 기존 DB에서는 `npm run db:migrate`로 `opening` 분류를 허용해야 합니다.

한 번에 한 수집 작업을 실행합니다. 작업 상태는 DB에 저장하므로 서버 프로세스가 달라도 같은 작업을 조회할 수 있습니다. 개별 상세 페이지 수집에 실패해도 해당 공고의 API 응답은 저장하고 관리자 화면에 실패 상태를 표시합니다.

선택 재수집은 성공한 공고의 DB 상세와 독립 상세 참조를 트랜잭션으로 교체합니다. 실패한 공고와 선택하지 않은 공고의 DB 자료는 그대로 둡니다. 번호별 독립 상세는 현재 형식으로 먼저 저장된 값을 유지하고, 이전 형식의 값은 재수집 시 교체합니다.

상세 자료 `pilot-5`에서는 필드 `value`를 `{ text, visible }` 배열로 저장합니다. 상세페이지와 모달은 같은 규칙으로 섹션별 필드·표 및 첨부 URL을 추출합니다. 새 독립 상세는 섹션과 첨부 URL을 담는 `schemaVersion: 5`를 사용합니다. 버전 2·3·4 독립 상세도 화면에서 표시하고, 해당 번호를 다시 수집하면 새 형식으로 교체합니다. 그보다 이전 형식은 재수집 안내를 표시합니다.

화면에는 DB에 저장된 공고만 표시됩니다. 상세 수집에 실패하면 DB에 이미 저장된 상세 자료를 유지합니다.

관련 공고는 공고번호와 차수로 식별해 별도 공고로 수집하며, 직접 발견한 관계만 양방향으로 연결합니다. 관련 공고로 발견된 기존 상세 자료는 다시 수집하지 않고 관계만 추가합니다. 상세 정보가 없는 공고는 이후 수집에서 다시 시도합니다. 관련 공고 하나가 실패해도 다른 관련 공고는 계속 처리하며, 상세 화면에서 각 관련 공고의 수집 실패 또는 정보 없음 상태를 확인할 수 있습니다.

클릭 상세 정보에서 **값 로딩 확인 시간 초과**가 표시되면 모달은 수집되었지만 값이 모두 채워졌는지는 확인되지 않은 상태입니다. 해당 항목은 나라장터 원문과 비교해 확인하세요.

## 검증

```powershell
npm test -- --run
npx tsc --noEmit
npm run build
```

실제 API와 공개 상세 페이지 한 건을 확인하려면 네트워크 접근이 가능한 환경에서 다음을 실행합니다.

```powershell
$env:LIVE_G2B='1'
npm test -- --run src/lib/g2b/api-client.live.test.ts src/lib/g2b/detail-page.live.test.ts
```

인증키를 입력한 뒤에는 짧은 날짜 범위를 수집해 목록·상세 화면과 첨부파일 다운로드를 확인하세요.

## 첫 버전의 범위

용역 공고만 수집합니다. 첨부 문서 본문 분석과 개인별 입찰 적합성 판정은 포함하지 않습니다. 화면의 `정보 없음`은 수집한 API와 공개 상세 페이지에서 해당 값을 확인하지 못했다는 뜻입니다. 최종 참가 조건과 제출 내용은 나라장터 원문 및 첨부파일을 확인하세요.
# g2b-api-detail-collector

## 운영 PDF 작업기 2단계

대기열 실행 코어는 `src/lib/documents/queue.ts`, `worker.ts`를 공유합니다. 관리자 화면도 같은 운영 대기열과 파일별 조회 API를 사용합니다. 기존 수집과 Actions는 변경하지 않았습니다.

- 자동 발견 포함 배치: `npm run pdf:extract -- --limit=20 --budget-minutes=50`
- 기존 대기열과 복구만: `npm run pdf:extract -- --queue-only --limit=20 --budget-minutes=50`
- 공고 범위 제한: 위 명령에 `--notice-key=공고키` 추가
- 로컬 작업기: `.env.local`에 `PDF_WORKER_ENABLED=true`, 32자 이상 `PDF_WORKER_TOKEN`을 설정하고 `docker compose --env-file .env.local -f compose.pdf-worker.yml up -d --build`

로컬은 `127.0.0.1:8788`만 공개합니다. 토큰 인증을 사용한 `GET /health`, `POST /wake`만 제공하며 첨부 URL이나 요청 생성은 받지 않습니다. 요청은 검증된 서버 코드에서 `DocumentQueue.enqueue`로 먼저 저장해야 합니다. 시작/깨우기마다 manual 요청만 최대 3건·20분 실행하며, 실행 중 깨우기는 같은 회차로 합칩니다. 연기된 재시도는 기다리지 않습니다. PDF 전용 외부 보완 작업을 활성화하기 전에는 다음 명시적 깨우기 또는 배치 실행이 필요합니다.

CLI는 한 회차 최대 20건·50분이며 마지막 6분에는 새 파일을 시작하지 않습니다. 작업기는 DB 행 임대(120초, 30초 갱신)를 공유하고, 갱신 실패·시간 초과 시 자식을 중단합니다. 문서 작업기 전용 연결 풀은 연결 대기 10초·쿼리 응답 15초를 제한합니다. 수집용 연결 풀은 바꾸지 않습니다.

재시도는 일시 오류만 최초 포함 3회, 1분·5분 지연입니다. 실패·후속 시도·현재 요청 포인터는 한 트랜잭션으로 저장합니다. 임대 만료 복구는 현재 체인만 확인하며, 성공 본문과 포인터는 실패/텍스트 없음으로 덮어쓰지 않습니다. 이미 성공한 동일 버전 문서는 자동 발견에서 재사용하고, 수동 요청은 새 체인을 만듭니다.

검증: `npx vitest run src/lib/documents --pool=threads`. 실제 DB 검사는 `LIVE_DB_TEST=1`과 DB 환경변수를 설정하여 `queue.live.test.ts`를 실행합니다. 검사 자료는 임의 이름의 전용 스키마에서 만들고 종료 시 정리합니다. 실제 공고·운영 이력은 수정하지 않습니다.

## PDF 자동화: GitHub Actions와 독립 보완 실행

`.github/workflows/pdf-extract.yml`은 기존 `G2B collection` 종료와 수동 dispatch를 받습니다. 기존 수집 워크플로·수집 cron 작업은 변경하지 않습니다. 실행 코드는 `main`에서만 checkout하며 원본 실행의 산출물은 사용하지 않습니다.

수집 종료 이벤트는 저장소·head_repository·main·워크플로 이름·경로 `.github/workflows/collect.yml`·원본 `workflow_dispatch`를 검증하고 success/failure/cancelled/timed_out을 허용합니다. 저장소 변수 `G2B_PDF_EXTRACTION_ENABLED=true`일 때만 수집 종료와 watchdog이 추출을 시작합니다. 수동 `invocation=manual` 검증은 자동 변수가 꺼져 있어도 가능합니다.

실제 활성화 순서:

1. 테스트를 통과한 전체 PDF 구현을 `main`에 반영합니다. 새 워크플로만 먼저 올리지 말고 공통 모듈·스크립트·DB 구조를 함께 준비합니다.
2. GitHub Actions Secret `DATABASE_URL`과 운영 DB 스키마를 확인합니다. 기존 수집의 Secret을 재사용합니다. 선택적인 저장소 변수 `G2B_DB_SCHEMA`의 기본값은 public입니다. 자동 실행 변수는 아직 false로 둡니다.
3. Actions의 **G2B PDF extraction**을 main에서 `mode=queue-only`, `invocation=manual`, `limit=1~3`, 필요 시 `notice_key`를 지정해 실행합니다. 관리자에서 접수한 대기 요청이 있어야 실제 추출·저장까지 검증됩니다. 대상이 없으면 사전 조회 후 빌드를 생략하는 것이 정상입니다.
4. 별도 PDF 전용 cron-job.org 작업을 **비활성**으로 등록합니다. `.github/pdf-watchdog.example.json`은 비밀값 없는 검토용 설정입니다. 본문의 ref=main, mode=queue-only, invocation=watchdog과 분 0/10/20/30/40/50을 유지합니다. 기존 수집 작업은 수정하지 않습니다.
5. 자동 변수를 true로 설정한 뒤 queue-only/watchdog을 직접 dispatch해 입력·자동 게이트·대기 처리·저장을 확인합니다. cron-job.org의 해당 PDF 작업도 테스트 실행하여 HTTP 성공과 GitHub 실행 접수를 확인합니다.
6. 성공하면 해당 PDF 작업을 활성화하고 다음 주기 호출 및 Actions 실행을 확인합니다. 실패하면 자동 변수를 false로 되돌리고 PDF 보완 작업을 비활성으로 유지합니다.

cron-job.org 호출은 GitHub의 `/repos/narahub123/g2b-api-detail-collector/actions/workflows/pdf-extract.yml/dispatches`에 POST합니다. 인증은 보호된 Authorization 헤더에만 설정합니다. 토큰은 해당 저장소의 Actions 쓰기 권한이 필요합니다. GitHub Variables를 API로 설정하려면 별도의 Variables 권한이 필요하며, 권한이 없으면 GitHub 설정 화면에서 값을 변경합니다. 키를 채팅이나 Git에 넣지 않습니다.

로컬 등록 도구:

- `node scripts/pdf-watchdog.mjs`: 실제 키 없이 비활성 작업 설정을 출력합니다.
- `.env.local`에 `CRON_JOB_API_KEY`, `PDF_GITHUB_TOKEN`을 설정하고 `node --env-file=.env.local scripts/pdf-watchdog.mjs --register`: main의 PDF 워크플로를 확인한 뒤 작업을 비활성으로 생성합니다. 같은 PDF 작업이 있으면 상세 설정의 비활성·POST·본문·10분 간격·인증까지 일치할 때만 재사용하며, 다른 설정이나 기존 수집 작업을 덮어쓰지 않습니다.

보완 호출은 본문을 가져오지 않는 읽기 전용 DB 조회로 준비 queued·만료 processing·누락된 재시도 체인을 확인합니다. 발견 모드에서는 새 PDF도 검사합니다. 유효한 임대가 있거나 대상이 없으면 Docker 빌드를 생략합니다. 새 작업기는 다시 DB 임대를 선점하므로 사전 조회 이후의 경쟁도 안전하게 종료합니다.

배치는 Docker HTTP 포트 없이 CPU 2개·메모리 4GiB로 실행합니다. 한 회차 최대 20건·50분, Actions 작업 제한 60분이며 파일당 50MiB·500페이지·5분 제한을 유지합니다. 요약은 처리 수·재시도·복구·남은 준비 요청·소요 시간·관측 메모리를 기록하고 본문·원본 PDF·비밀값은 로그나 Actions 산출물로 저장하지 않습니다.

현재 문서의 활성화 절차는 코드 구현과 별개입니다. 실제 main 반영·저장소 변수·외부 등록·다음 주기 호출까지 확인한 뒤 자동화 적용 완료로 기록합니다. 로컬 코드 검증만으로 외부 자동 실행이 활성화되지는 않습니다.

공식 기준: [GitHub workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run), [workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), [cron-job.org REST API](https://docs.cron-job.org/rest-api.html).
