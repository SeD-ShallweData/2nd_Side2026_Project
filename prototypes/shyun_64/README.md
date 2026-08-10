# shyun_64 프런트엔드 프로토타입

- 작업자: `shyun_64`
- 서버 원본: `/data/shared-SeD/jcu0304/figma-extract`, `/data/shared-SeD/jcu0304/donworry-landing.html`
- 보존 경로: `prototypes/shyun_64/`

Figma 시안을 개발에 활용할 수 있는 코드·에셋으로 정리하고, 별도의 단일 HTML 랜딩 프로토타입을 제작한 프런트엔드 작업입니다.

## `figma-extract/`

- Figma Dev Mode 원본 React·Tailwind 노드 8개
- 재사용할 수 있도록 정리한 React TSX 컴포넌트 7개
- 만료되는 Figma URL에서 내려받아 보존한 SVG 에셋 21개
- 내비게이션·히어로/커뮤니티·서비스 소개·위험 분석·AI 상담·푸터 원본 스크린샷
- Figma 노드와 컴포넌트·스크린샷을 연결하는 `manifest.json`
- 화면에서 반복 사용된 색상을 정리한 `design-tokens.css`

자세한 구성과 제품 적용 시 주의점은 [`figma-extract/README.md`](figma-extract/README.md)를 참고하세요.

## `donworry-landing.html`

별도 빌드 없이 브라우저에서 실행할 수 있는 반응형 단일 HTML 랜딩 프로토타입입니다.

- 라이트·다크 테마
- 서비스 소개, 위험카드, 커뮤니티, AI 상담 탭
- 사업장 위험도 카드와 업종별 시각 요소
- 반응형 레이아웃과 키보드 포커스 스타일
- 외부 프레임워크 없이 HTML·CSS·JavaScript만으로 실행

이 폴더는 개인 프런트엔드 작업을 보존합니다. 최종 제품에 채택하는 화면과 디자인 요소는 `product/`에서 별도로 통합합니다.
