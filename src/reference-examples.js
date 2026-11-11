import { parseAgentResult } from "./agent-result.js";

export const REFERENCE_FILE_NAME = "blueprint-reading-reference-examples.txt";

const text = (value) => (value === null || value === undefined || value === "" ? "없음" : String(value).replace(/\s+/g, " ").trim());

function exampleLines(data, number) {
  const elements = new Map((data.elements ?? []).map((element) => [element.id, element]));
  const lines = [`## 참고 예제 ${number}`, "", `전체 상태: ${text(data.status)}`, "", "### 형상과 치수 연결 예"];
  for (const feature of data.features ?? []) {
    lines.push(`- 형상 ${text(feature.id)} (${text(feature.type)}): ${text(feature.description)}`);
    for (const attribute of feature.attributes ?? []) {
      const linked = (attribute.linked_element_ids ?? [])
        .map((id) => `${id} "${text(elements.get(id)?.raw_text)}"`)
        .join(", ") || "연결한 표기 없음";
      lines.push(`  - ${text(attribute.name)}: ${linked} · 연결 상태 ${text(attribute.link_status)} · 공차 ${text(attribute.tolerance_text)}`
        + (attribute.derivation ? ` · 계산 ${text(attribute.derivation)}` : "")
        + ` · 근거 ${text(attribute.evidence)}`);
    }
  }
  lines.push("", "### 표기를 요소로 나눈 예");
  for (const element of data.elements ?? []) {
    lines.push(`- ${text(element.id)} [${text(element.category)}] 원문 "${text(element.raw_text)}" · 값 ${text(element.value)} ${element.unit ?? ""}`.trimEnd()
      + ` · 신뢰도 ${text(element.confidence)}${element.needs_confirmation ? " · 확인 필요" : ""}`);
  }
  return lines;
}

// 사람이 '확인 완료'로 표시한 결과만 Copilot Studio 지식에 올릴 참고 예제 문서로 만들어요.
export function buildReferenceExamples(entries) {
  const lines = [
    "# 도면 읽기 참고 예제",
    "",
    "이 문서는 사람이 확인한 과거 ② 분석 결과입니다.",
    "표기를 요소로 나누는 방식, 치수를 형상 속성에 연결하는 방식, 확인 필요를 남기는 방식만 참고합니다.",
    "이 문서의 값·원문·형상을 새 도면 결과에 옮기지 않습니다. 새 도면에서 직접 확인한 것만 씁니다.",
    "파일 이름, 좌표, 요약 문장은 넣지 않았습니다.",
    "",
  ];
  let count = 0;
  for (const entry of entries) {
    if (!entry.verified) continue;
    let data;
    try {
      ({ data } = parseAgentResult(entry.response));
    } catch {
      continue;
    }
    count += 1;
    lines.push(...exampleLines(data, count), "");
  }
  return { count, text: `${lines.join("\n").trimEnd()}\n` };
}
