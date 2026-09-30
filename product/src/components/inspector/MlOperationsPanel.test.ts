import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MlOperationsPanelView, type MlOperationsPanelViewProps } from "@/components/inspector/MlOperationsPanel";
import type { BatchStatus, BatchStatusListResponse } from "@/domain/batch";

const source = readFileSync(fileURLToPath(new URL("./MlOperationsPanel.tsx", import.meta.url)), "utf8");

function batch(overrides: Partial<BatchStatus>): BatchStatus {
  return {
    batch_id: 7, data_as_of: "2026-06-01", target_month: "2026-12-01", model_version: "model-v1", model_sha: null,
    ingested_at: "2026-09-20 15:26:00+09", source: null, n_scored: 553598, n_queue: 3000, n_safe: 503887,
    is_active: false, is_pinned: false, ...overrides,
  };
}

const DATA: BatchStatusListResponse = {
  selection_mode: "auto",
  current: batch({ batch_id: 7, is_active: true }),
  batches: [
    batch({ batch_id: 7, is_active: true }),
    batch({ batch_id: 6, data_as_of: "2026-05-01" }),
    batch({ batch_id: 9, data_as_of: null, n_scored: 0, n_queue: 0, n_safe: 0 }),
  ],
  generated_at: "2026-09-30T00:00:00.000Z",
  manageable: true,
};

function render(overrides: Partial<MlOperationsPanelViewProps> = {}): string {
  const props: MlOperationsPanelViewProps = {
    data: DATA, loading: false, loadError: null, selectedId: null, pending: null, busy: false, changeError: null, notice: null,
    onSelect: vi.fn(), onRequest: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(createElement(MlOperationsPanelView, props));
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("모델 운영 패널", () => {
  it("서버로 보내는 것은 배치 승인뿐이라는 안내를 화면에 적는다", () => {
    const html = text(render());
    expect(html).toContain("서버로 보내는 것은 배치 승인(서비스 배치 전환)뿐입니다.");
    expect(html).toContain("서버에 아무것도 보내지 않으며");
    expect(html.match(/설계안 · 서버 미연결/g)).toHaveLength(2);
  });

  it("임계값·재학습 버튼은 비활성이고 성공처럼 보이는 상태를 만들지 않는다", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>임계값 변경 요청 \(미구현\)<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>재학습 요청 \(미구현\)<\/button>/);
    // 예전 목업의 가짜 진행·승인 상태
    expect(source).not.toContain("setTimeout");
    expect(source).not.toContain("승인됨");
    expect(source).not.toContain("진행 중");
    expect(source).not.toContain("대기열 등록됨");
  });

  it("배치 승인은 실제 전환 API(activate/deactivate)와 같은 경로를 쓴다", () => {
    expect(source).toContain("/api/admin/batches/${pending.batch.batch_id}/activate");
    expect(source).toContain("\"/api/admin/batches/deactivate\"");
    expect(source).toContain("{ reason }");
    expect(source).toContain("/api/admin/batches?fields=batches");
  });

  it("적재가 끝난 서비스 외 배치만 승인 후보로 보이고, 고르기 전에는 승인 버튼이 비활성이다", () => {
    const html = render();
    expect(text(html)).toContain("서비스 중 배치 7 · 기준월 2026.06");
    expect(html).toContain("<option value=\"6\">배치 6 · 기준월 2026.05 · model-v1</option>");
    expect(html).not.toContain("<option value=\"7\"");
    expect(html).not.toContain("<option value=\"9\"");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>승인\(전환\)<\/button>/);
  });

  it("배치를 고르면 승인 버튼이 열리고, 요청하면 사유 입력을 거친다", () => {
    expect(render({ selectedId: 6 })).toMatch(/<button type="button" class="button button-dark button-small">승인\(전환\)<\/button>/);
    const html = text(render({ selectedId: 6, pending: { kind: "activate", batch: DATA.batches[1]! } }));
    expect(html).toContain("변경 사유 (감사 기록에 남습니다)");
    expect(html).toContain("승인하고 전환");
  });

  it("운영 DB 가 없으면 전환 버튼 대신 연결 안 됨을 알리고 배치 현황으로 안내한다", () => {
    const html = text(render({ data: { ...DATA, manageable: false } }));
    expect(html).toContain("운영 DB(wg_ops)가 연결되지 않은 서버라 여기서는 전환할 수 없습니다.");
    expect(html).not.toContain("승인(전환)");
    expect(render()).toContain("href=\"/inspector/batches\"");
  });

  it("전환 실패는 실패로 보인다", () => {
    const html = text(render({ selectedId: 6, pending: { kind: "activate", batch: DATA.batches[1]! }, changeError: "운영 DB 연결이 설정되지 않았습니다." }));
    expect(html).toContain("운영 DB 연결이 설정되지 않았습니다.");
  });
});
