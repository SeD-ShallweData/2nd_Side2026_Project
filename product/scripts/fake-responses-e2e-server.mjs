import http from "node:http";

const port = Number(process.env.FAKE_RESPONSES_PORT || 4319);
let sequence = 0;

function directive(message, name) {
  const prefix = `${name}=`;
  return message
    .split(/\r?\n/)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": `fake_req_${sequence}`,
  });
  res.end(JSON.stringify(payload));
}

function functionCall(name, callId, args) {
  return [
    {
      id: `rs_${sequence}`,
      type: "reasoning",
      encrypted_content: `opaque_${sequence}`,
      summary: [],
    },
    {
      id: `fc_${sequence}`,
      type: "function_call",
      status: "completed",
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
    },
  ];
}

function completed(output) {
  sequence += 1;
  return {
    id: `resp_fake_${sequence}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: "gpt-e2e-fake",
    output,
    usage: {
      input_tokens: 20,
      output_tokens: 8,
      total_tokens: 28,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
  };
}

function assistant(text) {
  return completed([
    {
      id: `msg_${sequence}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  ]);
}

function parsedOutputs(input) {
  return input
    .filter((item) => item?.type === "function_call_output" && typeof item.output === "string")
    .map((item) => {
      try {
        return { callId: item.call_id, value: JSON.parse(item.output) };
      } catch {
        return { callId: item.call_id, value: null };
      }
    });
}

function userMessage(input) {
  return [...input]
    .reverse()
    .find((item) => item?.role === "user" && typeof item.content === "string")
    ?.content ?? "";
}

function validateRequestContract(payload) {
  if (
    payload.parallel_tool_calls !== false ||
    payload.stream !== false ||
    payload.store !== false ||
    !Array.isArray(payload.include) ||
    !payload.include.includes("reasoning.encrypted_content") ||
    !Array.isArray(payload.tools) ||
    !payload.tools.every(
      (tool) =>
        tool?.type === "function" &&
        typeof tool.name === "string" &&
        tool.strict === true &&
        tool.parameters?.type === "object" &&
        tool.function === undefined,
    )
  ) {
    throw new Error("invalid_responses_contract");
  }

  const input = Array.isArray(payload.input) ? payload.input : [];
  const message = userMessage(input);
  const mode = directive(message, "E2E_TOOL") || "none";
  const outputs = input.filter((item) => item?.type === "function_call_output");
  const expectedChoice =
    mode === "contract" && outputs.length === 0
      ? { type: "function", name: "review_contract" }
      : "auto";
  if (JSON.stringify(payload.tool_choice) !== JSON.stringify(expectedChoice)) {
    throw new Error("invalid_tool_choice");
  }

  for (const output of outputs) {
    const call = input.find(
      (item) => item?.type === "function_call" && item.call_id === output.call_id,
    );
    const reasoning = input.find(
      (item) =>
        item?.type === "reasoning" &&
        typeof item.encrypted_content === "string" &&
        item.encrypted_content.length > 0,
    );
    if (!call || !reasoning) throw new Error("missing_function_call_round_trip");
  }
}

function nextOutput(body) {
  const input = Array.isArray(body.input) ? body.input : [];
  const message = userMessage(input);
  const mode = directive(message, "E2E_TOOL") || "none";
  const outputs = parsedOutputs(input);

  if (outputs.length === 0) {
    if (mode === "risk") {
      return completed(
        functionCall("get_company_risk", "call_risk", {
          company_id: directive(message, "E2E_COMPANY_ID") || "missing",
        }),
      );
    }
    if (mode === "search_chain") {
      return completed(
        functionCall("search_company", "call_search", {
          query: directive(message, "E2E_QUERY") || "없는사업장",
          limit: 5,
        }),
      );
    }
    if (mode === "rag") {
      return completed(
        functionCall("retrieve_labor_law", "call_rag", {
          query: directive(message, "E2E_QUERY") || "임금 지급일",
        }),
      );
    }
    if (mode === "contract") {
      return completed(
        functionCall("review_contract", "call_contract", {
          document_ref: "current_upload",
        }),
      );
    }
    if (mode === "unknown") {
      return completed(functionCall("read_secret_file", "call_unknown", {}));
    }
    return assistant("도구 없이 처리한 E2E 상담 답변입니다.");
  }

  if (mode === "search_chain" && outputs.length === 1) {
    if (!outputs[0]?.value?.ok) {
      return assistant("사업장 검색을 완료하지 못했습니다.");
    }
    const items = Array.isArray(outputs[0].value.data?.items)
      ? outputs[0].value.data.items
      : [];
    const candidates = items.slice(0, 5).map((item) => ({
      company_id: item?.company_id,
      company_name: item?.company_name,
    }));
    return assistant(`SEARCH_RESULTS ${JSON.stringify({ candidates })}`);
  }

  if (mode === "rag") {
    const documents = outputs.at(-1)?.value?.ok
      ? outputs.at(-1).value.data?.documents
      : [];
    const citation = Array.isArray(documents) ? documents[0]?.citation : null;
    return typeof citation === "string" && citation
      ? assistant(`확인된 공식 문서 근거를 조회했습니다 (${citation}).`)
      : assistant("공식 법령 검색 결과를 확인하지 못해 공식 상담 창구 확인이 필요합니다.");
  }

  if (mode === "contract") {
    if (!outputs.at(-1)?.value?.ok) {
      return assistant("계약서 검토 도구를 완료하지 못했습니다.");
    }
    const data = outputs.at(-1).value.data ?? {};
    const findings = [
      ...(Array.isArray(data.missing_items) ? data.missing_items : []),
      ...(Array.isArray(data.review_items) ? data.review_items : []),
      ...(Array.isArray(data.detected_items) ? data.detected_items : []),
    ];
    const first = findings[0];
    return assistant(`CONTRACT_RESULT ${JSON.stringify({
      analysis_status: data.analysis_status,
      file_name: data.file_name,
      review_id: data.review_id,
      finding_count: findings.length,
      first_finding: first
        ? { code: first.code, label: first.label, status: first.status }
        : null,
    })}`);
  }

  if (mode === "unknown") {
    return assistant("허용되지 않은 도구는 실행하지 않았습니다.");
  }

  return assistant("허용된 사업장 조회 도구 실행 결과를 확인했습니다.");
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, { ok: true });
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/responses") {
    json(res, 404, { error: "not_found" });
    return;
  }

  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on("end", () => {
    try {
      const payload = JSON.parse(body);
      validateRequestContract(payload);
      json(res, 200, nextOutput(payload));
    } catch (error) {
      json(res, 400, {
        error: error instanceof SyntaxError ? "invalid_json" : "invalid_responses_contract",
      });
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`fake Responses E2E server ready on 127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
