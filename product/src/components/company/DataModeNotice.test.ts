import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DataModeNotice } from "@/components/company/DataModeNotice";

const props = {
  dataMode: "real" as const,
  realMessage: "PostgreSQL의 사업장 명부를 읽기 전용으로 조회합니다.",
  mockMessage: "시연을 위한 데모 데이터입니다.",
};

describe("데이터 출처 배너", () => {
  it("세션을 확인하기 전에는 아무것도 그리지 않는다", () => {
    // 서버 렌더에는 useEffect 가 돌지 않는다. 로그인하지 않은 방문자가 첫 화면에서
    // 배너를 보게 되는 일이 없어야 한다.
    const html = renderToStaticMarkup(createElement(DataModeNotice, props));

    expect(html).toBe("");
    expect(html).not.toContain("READ ONLY DB");
    expect(html).not.toContain("PostgreSQL");
  });
});
