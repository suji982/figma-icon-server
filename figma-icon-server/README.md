# Figma 아이콘 생성 서버 (나노바나나 무료 티어 연동)

Figma 플러그인이 API 키 없이도 3D 클레이 스타일 아이콘 이미지를 생성할 수 있게 해주는
중간 서버(엔드포인트)입니다. API 키는 이 서버(Vercel)에만 저장되고, 플러그인은 절대
키를 알지 못합니다.

**모델은 나노바나나(gemini-2.5-flash-image, Pro 아님)를 씁니다.** 카드 등록 없이
하루 최대 500장까지 무료로 쓸 수 있어서, 팀이 공용으로 쓰는 도구인데 결제 계정을 누가
떠안을지 정하지 않아도 되도록 이걸 선택했습니다. 나노바나나 프로(gemini-3-pro-image-preview)는
무료 티어가 없어서 제외했습니다. (품질이 부족하면 나중에 이 모델명만 바꿔서 유료로
전환할 수 있습니다 — `api/generate-icon.js`의 `GEMINI_MODEL` 상수 참고.)

> ⚠️ Google의 무료/유료 정책은 바뀔 수 있으니, 배포 전에
> https://ai.google.dev/gemini-api/docs/pricing 에서 최신 상태를 한 번 확인하세요.

**이 서버의 역할은 "이미지 생성"까지입니다.** 배경 제거는 여기서 다루지 않습니다 —
remove.bg의 Figma 플러그인처럼, 그 로직/API 호출은 Figma 플러그인 쪽 코드 안에서
별도로 붙이는 걸 전제로 합니다.

```
Figma 플러그인 → (fetch) → /api/generate-icon → (키와 함께) → Gemini 3 Pro Image API
                                                                     │
플러그인 캔버스 ← ── 이미지(base64, 화이트 배경) + backgroundColor ───┘
                     (배경 제거는 플러그인 쪽에서 처리)
```

## 1. 배포하기 (Vercel) — 상세 순서

### 1-1. Gemini API 키 발급

1. https://aistudio.google.com 접속 → Google 계정으로 로그인
2. 좌측 메뉴에서 "Get API key" 클릭 → API 키 생성 (무료, 즉시 발급)
3. 나노바나나(gemini-2.5-flash-image)는 무료 티어가 있어서, **카드 등록 없이 바로**
   테스트할 수 있습니다. (다만 프로젝트/계정별로 하루 요청 한도가 있으니, 실제 사용량이
   늘면 AI Studio 대시보드에서 한도를 확인하세요.)
4. 발급받은 API 키 문자열을 잠시 메모해둡니다 (`AIza...` 형태).

### 1-2. 코드 저장소 준비

1. 이 폴더(`figma-icon-server/`) 전체를 로컬에 다운로드
2. GitHub에 새 저장소를 만들고 이 폴더를 push
   ```bash
   cd figma-icon-server
   git init
   git add .
   git commit -m "init"
   git remote add origin https://github.com/{내계정}/figma-icon-server.git
   git branch -M main
   git push -u origin main
   ```
   (Git이 낯설면 GitHub Desktop 앱으로 폴더를 드래그해서 올려도 됩니다.)

### 1-3. Vercel 배포

1. https://vercel.com 접속 → "Continue with GitHub"로 로그인/가입
2. 대시보드에서 **"Add New..." → "Project"** 클릭
3. 방금 올린 GitHub 저장소(`figma-icon-server`)를 찾아서 **Import** 클릭
4. Configure Project 화면에서:
   - Framework Preset: "Other" (자동 감지되면 그대로 둠)
   - Root Directory: 기본값(`./`) 그대로
5. **화면을 내려서 "Environment Variables" 섹션**을 펼치고 추가:
   | Key | Value |
   |---|---|
   | `GEMINI_API_KEY` | 1-1에서 메모해둔 API 키 |
6. **Deploy** 버튼 클릭 → 1~2분 정도 빌드 대기
7. 완료되면 화면에 배포된 URL이 나타남 (예: `https://figma-icon-server-xxxx.vercel.app`)

### 1-4. 엔드포인트 확인

최종 엔드포인트는 이 URL 뒤에 `/api/generate-icon`을 붙인 주소입니다.

```
https://figma-icon-server-xxxx.vercel.app/api/generate-icon
```

### 1-5. 정상 동작 테스트 (터미널 또는 Postman)

```bash
curl -X POST https://figma-icon-server-xxxx.vercel.app/api/generate-icon \
  -H "Content-Type: application/json" \
  -d '{"subject": "laptop"}'
```

성공하면 `{"subject":"laptop","mimeType":"image/png","imageBase64":"...","backgroundColor":"#FFFFFF"}`
형태의 JSON이 돌아옵니다. `imageBase64` 앞부분을 아래처럼 디코딩해서 이미지로 저장해보면
결과를 눈으로 확인할 수 있습니다.

```bash
curl -X POST https://figma-icon-server-xxxx.vercel.app/api/generate-icon \
  -H "Content-Type: application/json" -d '{"subject": "laptop"}' \
  | python3 -c "import sys,json,base64; d=json.load(sys.stdin); open('test.png','wb').write(base64.b64decode(d['imageBase64']))"
```

### 1-6. 코드 수정 후 재배포

`assets/`의 참조 이미지를 바꾸거나 `STYLE_TEMPLATE`을 수정한 뒤에는:

```bash
git add .
git commit -m "update style"
git push
```

Vercel이 GitHub push를 감지해서 자동으로 재배포합니다 (별도 명령 불필요).

## 2. API 사용법

**요청 (POST)**

```json
{
  "subject": "camera",
  "extraDetail": "vintage rangefinder style",     // 선택
  "referenceImageBase64": "<특정 요청만 다른 스타일로 하고 싶을 때, 선택>"
}
```

**응답**

```json
{
  "subject": "camera",
  "mimeType": "image/png",
  "imageBase64": "iVBORw0KGgoAAAANSUhEUgAA...",
  "backgroundColor": "#FFFFFF"
}
```

`imageBase64`는 아직 화이트 배경이 그대로 남아있는 상태입니다. `backgroundColor`는
플러그인 쪽에서 배경 제거 시 참고할 배경색입니다.

## 3. 스타일 커스터마이징

`api/generate-icon.js` 안의 `STYLE_TEMPLATE` 문자열이 오브젝트 스타일(재질·색감·
비례·조명)과 배경색을 함께 정의합니다. 수정하면 전체 아이콘 세트에 일괄 반영됩니다.

## 4. 스타일이 서버에 이미 고정되어 있습니다

`assets/` 폴더의 3장(`style-anchor-1-car.png`, `-2-camera.png`, `-3-meeting.png`)은
매 요청마다 자동으로 참조 이미지로 붙습니다. 스타일을 바꾸려면 이 파일들을 원하는
예시로 교체(`style-anchor-` + `.png` 파일명 유지)하고 재배포하면 됩니다.

> **참고:** 참조 이미지 앵커링도 100% 완벽한 재현은 아닙니다. 나노바나나 계열은
> seed 파라미터를 지원하지 않는 아키텍처라서, 결과가 매번 살짝씩 다른 건 정상입니다.
> 무료 모델(gemini-2.5-flash-image)이 유료 프로 모델보다 참조 이미지 반영이나 세부
> 텍스트 렌더링이 다소 떨어질 수 있으니, 배포 후 실제 결과 품질을 꼭 확인해보세요.

## 5. 배경이 화이트인 이유, 그리고 나중에 배경 제거할 때 주의할 점

크로마키 그린이 아니라 화이트를 쓴 이유는, 그린을 쓰면 배경 제거 시 피사체 가장자리에
초록빛이 살짝 번지는 문제(color spill)가 생길 수 있어서예요.

다만 화이트도 트레이드오프가 있습니다: 나중에 플러그인에서 배경을 **"흰색 픽셀을 지운다"는
색상 기반 스크립트**로 직접 제거할 계획이라면, 피사체 안에 있는 밝은 색 부분(예: 카메라의
은색 바디, 미팅 세트의 크림색 사인보드)도 같이 지워질 위험이 있어요.

이 위험을 피하려면:
- **ML 기반 배경제거 API(remove.bg 등)를 플러그인에서 호출**하는 걸 추천합니다. 색상이
  아니라 "이게 배경인지 피사체인지"를 이미지 자체에서 학습된 모델로 판단하기 때문에,
  피사체 안의 흰색 부분은 지우지 않고 바깥 배경만 정확히 제거해줍니다.
- 직접 색상 기반 스크립트를 짜야 한다면, 이미지 가장자리(테두리 몇 픽셀)에서 시작해서
  안쪽으로 번져나가는 "flood-fill" 방식으로 배경만 추적하는 게, 전체 이미지에서 흰 픽셀을
  무작정 찾는 것보다 훨씬 안전합니다.

## 6. Figma 플러그인 연동

`figma-plugin-example/code.js` 참고. 서버 관련 핵심은 두 가지입니다.

1. `manifest.json`에 서버 도메인을 네트워크 허용 목록에 등록:

   ```json
   {
     "networkAccess": {
       "allowedDomains": ["https://your-project.vercel.app"]
     }
   }
   ```

2. 플러그인에서 `fetch(SERVER_ENDPOINT, { method: "POST", ... })` 로 호출 → 응답의
   `imageBase64`(화이트 배경 상태)를 받아옴.

배경 제거는 이 지점부터 플러그인 쪽 몫입니다. `figma.createImage()`로 캔버스에 삽입하기
*전에*, `imageBase64`를 배경 제거 로직/API에 먼저 통과시키면 됩니다.
