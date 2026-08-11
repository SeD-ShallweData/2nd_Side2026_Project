# 제품 내부 통합 서비스

브라우저는 이 디렉터리의 Flask 서비스에 직접 접근하지 않고 Next.js의 `/api/*`만 호출합니다.

- `rag-api`: HB 프로토타입의 BGE-M3·Chroma 검색 자산을 제품용 검색 전용 API로 분리한 사본
- `contract-api`: CSH 프로토타입의 Document Parse·조항 추출·규칙 엔진을 제품 내부 API로 가져온 사본

두 원본 프로토타입은 포트폴리오와 개발 이력 보존용이므로 수정하지 않습니다. 제품에 필요한 변경은 이
디렉터리와 `src/adapters/real`에서만 진행합니다. 실행 방법은 상위 [README](../README.md)를 참고하세요.
