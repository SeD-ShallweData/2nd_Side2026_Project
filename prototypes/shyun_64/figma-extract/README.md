# Figma Dev Mode 추출 결과

원본 링크의 `4:2`는 단일 프레임이 아니라 여러 화면 조각이 놓인 Figma 페이지입니다. 실제 UI가 들어 있는 노드 6개와 내비게이션 1개를 각각 React TSX로 추출했습니다.

## 포함 파일

- `components/`: 로컬 SVG 경로(`/assets/...`)가 적용된 React 컴포넌트
- `raw/`: Figma가 반환한 원본 React + Tailwind 스니펫
- `assets/`: 만료되는 Figma 주소에서 내려받아 보존한 SVG 21개
- `screenshots/`: 각 프레임의 원본 크기 PNG
- `overview.png`: `4:2` 페이지 전체 축소 미리보기
- `manifest.json`: Figma 노드, 컴포넌트, 스크린샷 매핑
- `design-tokens.css`: 생성 코드에서 관찰된 핵심 색상 토큰

## 컴포넌트

| Figma 노드 | 컴포넌트 | 내용 |
| --- | --- | --- |
| `13:9` | `Navigation` | 로고, 메뉴, 로그인/시작 버튼 |
| `13:303` | `HeroCommunity` | 히어로, 지표, 커뮤니티 카드 |
| `13:120` | `HowItWorks` | 4단계 서비스 소개 |
| `13:304` | `RiskAnalysis` | 사업장 위험카드와 지표 |
| `13:738` | `AIConsultation` | RAG AI 상담 예시 |
| `13:7` | `FooterCTA` | 시작 CTA와 푸터 |

## 사용 시 주의점

컴포넌트는 Figma Dev Mode가 반환한 React + Tailwind 골격입니다. 원본의 고정 데스크톱 폭(`1152px`)과 일부 절대 위치도 그대로 포함되어 있으므로, 제품 코드에 넣기 전 반응형 레이아웃과 접근성 처리가 필요합니다.

이미지는 `/assets/...` 경로를 사용합니다. Next.js나 Vite 프로젝트에서는 이 폴더의 SVG를 프로젝트의 `public/assets/`로 복사하면 됩니다. 글꼴은 `Noto Sans KR`의 Regular, Bold, Black 굵기를 사용합니다.

Figma에서 정의된 변수로 확인된 값은 흰색 배경 두 개뿐입니다. `design-tokens.css`의 나머지 색상은 생성 코드에서 반복 사용된 값을 정리한 관찰 토큰입니다.
