/*
 * vitest 전용 빈 모듈. vitest.config.ts 의 resolve.alias 가 "server-only" 를 이 파일로 연결한다.
 *
 * "server-only" 는 Next 빌드가 서버 번들에서는 빈 모듈로, 클라이언트 번들에서는 빌드 오류로
 * 바꾸는 표식이다. 패키지가 node_modules 에 따로 설치돼 있지 않아서 테스트에서는 해석되지 않는다.
 * 이 별칭 덕분에 vi.mock("server-only") 없이도 서버 모듈을 불러올 수 있다.
 * 클라이언트에서 서버 모듈을 불러오는 실수는 next build 와 clientSecretBoundary.test.ts 가 잡는다.
 */
export {};
