import type { NextConfig } from "next";

/*
 * 모든 경로에 붙이는 보안 헤더.
 *
 * - 응답 형식을 브라우저가 추측하지 않게 한다(nosniff).
 * - 다른 사이트로 나갈 때 주소 전체 대신 출처만 넘긴다.
 *
 * 전체 CSP(script-src 등)와 HSTS 는 넣지 않는다. 전체 CSP 는 Next 인라인 스크립트와 맞춰야
 * 하고, HSTS 는 앞단(Tailscale Funnel)이 TLS 를 맡고 있어 여기서 정할 일이 아니다.
 */
const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

/*
 * 다른 사이트가 iframe 에 넣지 못하게 하는 헤더(클릭재킹 방지). 오래된 브라우저용
 * X-Frame-Options 와 표준 CSP frame-ancestors 를 함께 둔다.
 *
 * 관리자·감독 화면과 로그인·회원가입 화면에만 붙인다. 공개 화면(첫 화면·상담·사업장·계약서·
 * 커뮤니티 등)은 발표 슬라이드, Notion, 심사 포털 미리보기처럼 다른 사이트 안에 넣어 보여 줄 수
 * 있어야 한다. 세션 쿠키가 SameSite=Lax 라 다른 사이트의 iframe 에는 로그인 상태가 실리지 않으므로,
 * 공개 화면까지 막아서 얻는 방어 효과는 거의 없고 임베드만 깨진다.
 *
 * '/admin/:path*' 는 /admin 자체와 그 아래(/admin/batches)를 모두 덮는다(/inspector 도 같다).
 */
const FRAME_DENY_HEADERS: { key: string; value: string }[] = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
];

const FRAME_DENY_SOURCES = ["/admin/:path*", "/inspector/:path*", "/login", "/signup"];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 응답에 x-powered-by: Next.js 를 싣지 않는다. 프레임워크를 굳이 알릴 이유가 없다.
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      ...FRAME_DENY_SOURCES.map((source) => ({ source, headers: FRAME_DENY_HEADERS })),
    ];
  },
  images: {
    // 시연 서버는 proxy.ts 의 Basic auth 뒤에 있다. 그런데 /_next/image 는 원본을
    // 가져올 때 헤더 없는 내부 요청을 만들어 자기 라우터 핸들러에 다시 넣는다
    // (next/dist/server/image-optimizer.js 의 fetchInternalImage → routerServerHandler).
    // Authorization 이 없으니 proxy.ts 가 401 과 안내문을 돌려주고, 최적화기는 그 본문에서
    // 이미지 타입을 못 읽어 "The requested resource isn't a valid image" 400 을 낸다.
    // 브라우저가 직접 부르면 자격증명이 있어 200 이므로, 원본만 그대로 내보내면 된다.
    //
    // 끄는 쪽을 고른 이유: 대상이 /brand 의 PNG 세 장(45~49KB)뿐이고 192px 로 그려서
    // 최적화 이득이 없다. 반대로 켜 두려면 proxy.ts 에서 정적 자산을 면제해 외곽 인증에
    // 구멍을 내고, .next/cache 를 쓸 수 있게 systemd 유닛(ProtectSystem=strict)까지
    // 손봐야 한다. 얻는 것에 비해 건드릴 곳이 많다.
    unoptimized: true,
  },
  experimental: {
    authInterrupts: true,
    // The server environment drops captured stdout from Next's detached tsc child process.
    // Use the TypeScript compiler API so production builds still run the same type checks.
    useTypeScriptCli: false,
  },
};

export default nextConfig;
