import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
