# web/assets/ — 프런트에서 바로 쓰는 디자인 리소스

브라우저가 `/assets/...` 경로로 직접 불러오는 파일들입니다.

| 폴더 | 넣을 것 | HTML/CSS에서 쓰는 경로 |
|---|---|---|
| `logo/` | 로고, 파비콘 (SVG 권장) | `/assets/logo/logo.svg` |
| `icons/` | 아이콘 (SVG) | `/assets/icons/warning.svg` |
| `images/` | 배경·일러스트 (WebP·PNG) | `/assets/images/hero.webp` |
| `fonts/` | 웹폰트 (woff2) | `/assets/fonts/Pretendard.woff2` |

## 규칙

- **파일 하나에 500KB를 넘기지 마세요.** 홈 디스크 여유가 21G뿐이고 git에도 올라갑니다.
- 큰 원본(PSD, AI, Figma export 원본, 촬영 이미지)은 여기가 아니라 [design/](../../design/) — `/data/shared-SeD/csh/design/` 에 둡니다.
- 색·모서리·간격은 [css/style.css](../css/style.css) 맨 위 `:root` 토큰을 고치면 전체에 반영됩니다. 개별 규칙에 색을 직접 쓰지 마세요.

## 웹폰트 적용 예시

`web/css/style.css` 맨 위에 추가:

```css
@font-face {
  font-family: "Pretendard";
  src: url("/assets/fonts/Pretendard-Regular.woff2") format("woff2");
  font-weight: 400;
  font-display: swap;
}

:root { --font: "Pretendard", system-ui, sans-serif; }
```
