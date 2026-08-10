# hb-rag-bot 프로토타입

- 원본 브랜치: `hb-rag-bot`
- 보존 기준 커밋: `fb46e43`
- 원본 경로: `webapp/`
- 보존 경로: `prototypes/hb-rag/`

Flask 기반 노동법 상담, Chroma 벡터 검색, 계약서 검토와 검색·생성 단계 평가 도구를 포함합니다.

## 주요 구성

- `app.py`: 상담·계약서 검토 API
- `bot.py`: 법령 검색과 답변 생성
- `contract_review.py`: 계약서 분석 흐름
- `data/labor_law_db/`: 보존 시점의 Chroma DB
- `eval/`: 검색 정확도·법령 원문·인용 환각 검증
- `static/`: 프로토타입 화면

세부 평가 방법은 [`eval/README.md`](eval/README.md)를 참고하세요.

이 디렉터리는 원본 프로토타입을 보존합니다. 서버 절대경로, 모델 캐시와 API 키는 새 환경에서 다시 설정해야 하며, 최종 제품에 채택하는 기능은 `product/`에서 별도로 통합합니다.
