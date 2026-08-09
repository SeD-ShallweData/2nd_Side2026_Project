import json
import os
import urllib.error
import urllib.request

from dotenv import load_dotenv


ENV_FILE = os.getenv("API_KEY_ENV_FILE", "/data/shared-SeD/api_key.env")
QUESTION = "손흥민 선수의 최근 경기 기록을 알려줘."


def call_api(label: str, api_key: str, api_url: str, model: str) -> bool:
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": QUESTION}],
        "temperature": 0.0,
    }
    request = urllib.request.Request(
        api_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
        answer = result["choices"][0]["message"]["content"]
        print(f"\n[{label}] 성공")
        print(f"[{label}] 모델: {result.get('model', model)}")
        print(f"[{label}] 응답: {answer}")
        return True
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        print(f"\n[{label}] 실패 (HTTP {error.code})")
        print(f"[{label}] 서버 응답: {body}")
    except urllib.error.URLError as error:
        print(f"\n[{label}] 연결 실패: {error.reason}")
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
        print(f"\n[{label}] 예상하지 못한 응답 형식: {error}")
    return False


def main() -> None:
    if not os.path.exists(ENV_FILE):
        raise SystemExit(f"키 파일을 찾을 수 없습니다: {ENV_FILE}")
    load_dotenv(ENV_FILE)

    services = [
        {
            "label": "Upstage",
            "key": os.getenv("Upstage_API_KEY"),
            "url": os.getenv(
                "UPSTAGE_API_URL",
                "https://api.upstage.ai/v1/chat/completions",
            ),
            "model": os.getenv("UPSTAGE_MODEL", "solar-pro3"),
        },
        {
            "label": "SKT",
            "key": os.getenv("SKT_API_KEY"),
            "url": os.getenv(
                "SKT_API_URL",
                "https://awf-gw.adot.ai/v1/chat/completions",
            ),
            "model": os.getenv("SKT_MODEL", "A.X-K1"),
        },
    ]

    print(f"키 파일: {ENV_FILE}")
    print(f"질문: {QUESTION}")
    results = []
    for service in services:
        missing = [
            name
            for name, value in (
                ("API 키", service["key"]),
                ("API URL", service["url"]),
                ("모델", service["model"]),
            )
            if not value
        ]
        if missing:
            print(
                f"\n[{service['label']}] 미실행: "
                f"{', '.join(missing)} 설정이 필요합니다."
            )
            results.append(False)
            continue

        results.append(
            call_api(
                service["label"],
                service["key"],
                service["url"],
                service["model"],
            )
        )

    print(f"\n결과: {sum(results)}/{len(services)}개 API 호출 성공")


if __name__ == "__main__":
    main()
