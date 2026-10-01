/*
 * 문구 속 "\n" 은 모바일에서만 줄을 바꾸는 자리다. 넓은 화면에서는 줄바꿈을 숨기고
 * 그 자리에 띄어쓰기 한 칸만 남긴다(.mobile-break).
 */
export function withMobileBreaks(text: string) {
  const lines = text.split("\n");
  return lines.map((line, index) => (
    <span key={index}>{line}{index < lines.length - 1 ? <>{" "}<br className="mobile-break" /></> : null}</span>
  ));
}
