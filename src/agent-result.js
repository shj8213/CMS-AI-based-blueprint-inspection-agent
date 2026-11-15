const RESULT_LISTS = [
  ["pages", "페이지"],
  ["elements", "읽은 요소"],
  ["features", "형상"],
  ["dimension_chains", "치수 합계"],
  ["stage_log", "단계별 결과"],
  ["limitations", "판독 한계"],
];

const STAGE_NAMES = [
  "영역·형상",
  "치수 읽기와 연결",
  "치수공차·끼워맞춤",
  "기하공차·데이텀",
  "표면거칠기·주서·표제란",
  "계산·전체 대조",
];

export class AgentResultError extends Error {}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkList(parent, key, label, records = false) {
  const value = parent[key];
  if (value == null) return;
  if (!Array.isArray(value)) {
    throw new AgentResultError(`${label} 목록은 대괄호 [ ]로 된 목록이어야 해요. ②의 JSON을 빠짐없이 복사했는지 확인해 주세요.`);
  }
  if (records) {
    value.forEach((item, index) => {
      if (!isRecord(item)) {
        throw new AgentResultError(`${label}의 ${index + 1}번째 항목 형식이 맞지 않아요.`);
      }
    });
  }
}

function checkId(value, label) {
  if (value != null && typeof value !== "string" && typeof value !== "number") {
    throw new AgentResultError(`${label}에는 글자나 숫자로 된 번호를 써야 해요.`);
  }
}

function checkIds(parent, key, label) {
  checkList(parent, key, label);
  for (const value of parent[key] ?? []) checkId(value, label);
}

function checkConfirmation(record, label) {
  if (record.needs_confirmation != null && typeof record.needs_confirmation !== "boolean") {
    throw new AgentResultError(`${label}의 확인 필요 상태는 true 또는 false여야 해요.`);
  }
}

function validateReviewResult(data) {
  const statuses = ["검토 완료", "부분 완료", "입력 필요"];
  const classifications = ["틀림", "확인 필요"];
  const issueTypes = ["누락", "읽기 불확실", "연결 불확실", "표기 불일치"];
  const confidences = ["높음", "중간", "낮음"];
  if (!statuses.includes(data.status)) {
    throw new AgentResultError("③ 검토 결과의 상태가 정해진 값과 달라요.");
  }
  for (const key of ["review_basis", "summary", "human_review_status"]) {
    if (typeof data[key] !== "string") {
      throw new AgentResultError(`③ 검토 결과의 ${key}는 글자여야 해요.`);
    }
  }
  if (data.human_review_status !== "미확인") {
    throw new AgentResultError("사람이 직접 확인했는지는 홈페이지에서 바꿀 수 없어요. human_review_status를 '미확인'으로 두세요.");
  }
  for (const key of ["reviewed_pages", "unreviewed_pages"]) {
    checkList(data, key, key === "reviewed_pages" ? "확인한 페이지" : "확인하지 못한 페이지");
    if (!data[key] || data[key].some((page) => !Number.isInteger(page) || page < 1)) {
      throw new AgentResultError(`${key}에는 1 이상의 페이지 번호만 넣어 주세요.`);
    }
  }
  checkList(data, "findings", "지적", true);
  checkList(data, "not_missing", "이미 확인된 정보", true);
  checkList(data, "limitations", "검토 한계");
  if (!data.findings || !data.not_missing || !data.limitations) {
    throw new AgentResultError("③ 검토 결과에 findings, not_missing, limitations 목록을 모두 넣어 주세요.");
  }
  if (data.limitations.some((item) => typeof item !== "string")) {
    throw new AgentResultError("검토 한계는 글자 목록이어야 해요.");
  }
  for (const [index, finding] of data.findings.entries()) {
    const label = `${index + 1}번째 지적`;
    if (!classifications.includes(finding.classification) || !issueTypes.includes(finding.issue_type)) {
      throw new AgentResultError(`${label}의 분류 값이 정해진 값과 달라요.`);
    }
    if (!confidences.includes(finding.confidence)) {
      throw new AgentResultError(`${label}의 신뢰도는 높음, 중간, 낮음 중 하나여야 해요.`);
    }
    for (const key of ["id", "location", "what", "why", "basis", "how_to_resolve", "evidence", "confidence_reason", "next_check"]) {
      if (typeof finding[key] !== "string") {
        throw new AgentResultError(`${label}의 ${key}는 글자여야 해요.`);
      }
    }
    if (finding.intent_hypothesis != null && typeof finding.intent_hypothesis !== "string") {
      throw new AgentResultError(`${label}의 intent_hypothesis는 글자여야 해요.`);
    }
    checkList(finding, "analysis_item_ids", `${label}의 ② 항목 ID`);
    if (!finding.analysis_item_ids || finding.analysis_item_ids.some((id) => typeof id !== "string")) {
      throw new AgentResultError(`${label}의 ② 항목 ID는 글자 목록이어야 해요.`);
    }
  }
  for (const [index, item] of data.not_missing.entries()) {
    for (const key of ["item", "location", "reason"]) {
      if (typeof item[key] !== "string") {
        throw new AgentResultError(`이미 확인된 정보 ${index + 1}번째 항목의 ${key}는 글자여야 해요.`);
      }
    }
    checkList(item, "analysis_item_ids", `이미 확인된 정보 ${index + 1}번째 항목의 ② 항목 ID`);
    if (!item.analysis_item_ids || item.analysis_item_ids.some((id) => typeof id !== "string")) {
      throw new AgentResultError(`이미 확인된 정보 ${index + 1}번째 항목의 ② 항목 ID는 글자 목록이어야 해요.`);
    }
  }
}

function validateResult(data) {
  if (isRecord(data) && data.schema_version === "2.0") {
    validateReviewResult(data);
    return;
  }
  if (!isRecord(data) || !RESULT_LISTS.some(([key]) => key in data) && !("status" in data)) {
    throw new AgentResultError("② 분석 결과 형식이 아니에요. 상태와 목록이 들어 있는 JSON 전체를 복사해 주세요.");
  }
  if (data.source != null && !isRecord(data.source)) {
    throw new AgentResultError("도면 정보(source)의 형식이 맞지 않아요.");
  }
  if (data.status != null && typeof data.status !== "string") {
    throw new AgentResultError("전체 상태(status)는 글자여야 해요.");
  }
  if (data.schema_version != null && typeof data.schema_version !== "string") {
    throw new AgentResultError("결과 형식 버전(schema_version)은 글자여야 해요.");
  }

  for (const [key, label] of RESULT_LISTS) {
    checkList(data, key, label, !["limitations"].includes(key));
  }
  if (data.source) {
    checkList(data.source, "analyzed_pages", "분석한 페이지");
    checkList(data.source, "unanalyzed_pages", "분석하지 못한 페이지");
  }
  for (const [index, page] of (data.pages ?? []).entries()) {
    const label = `${index + 1}번째 페이지의 뷰`;
    checkList(page, "views", label, true);
    for (const view of page.views ?? []) checkId(view.id, `${label} 번호`);
  }
  for (const [index, element] of (data.elements ?? []).entries()) {
    const label = `${index + 1}번째 요소`;
    checkId(element.id, `${label} 번호`);
    checkId(element.view_id, `${label}의 뷰 번호`);
    checkConfirmation(element, label);
    if (element.location != null && !isRecord(element.location)) {
      throw new AgentResultError(`${label}의 위치 정보 형식이 맞지 않아요.`);
    }
  }
  for (const [index, feature] of (data.features ?? []).entries()) {
    const label = `${index + 1}번째 형상`;
    checkId(feature.id, `${label} 번호`);
    checkConfirmation(feature, label);
    checkIds(feature, "view_ids", `${label}의 뷰 번호`);
    checkList(feature, "attributes", `${label}의 속성`, true);
    for (const [attributeIndex, attribute] of (feature.attributes ?? []).entries()) {
      checkIds(attribute, "linked_element_ids", `${label}의 ${attributeIndex + 1}번째 속성의 연결 번호`);
    }
  }
  for (const [index, chain] of (data.dimension_chains ?? []).entries()) {
    const label = `${index + 1}번째 치수 합계`;
    checkId(chain.id, `${label} 번호`);
    checkId(chain.overall_element_id, `${label}의 전체 치수 번호`);
    checkIds(chain, "element_ids", `${label}의 요소 번호`);
  }
  for (const [index, stage] of (data.stage_log ?? []).entries()) {
    checkList(stage, "issues", `${index + 1}번째 단계의 남은 문제`);
  }
}

function jsonErrorMessage(error, text) {
  const lineMatch = error.message.match(/line\s+(\d+)/i);
  const positionMatch = error.message.match(/position\s+(\d+)/i);
  const line = lineMatch
    ? Number(lineMatch[1])
    : positionMatch ? text.slice(0, Number(positionMatch[1])).split("\n").length : null;
  const location = line ? ` JSON의 ${line}번째 줄 근처를 살펴봐 주세요.` : "";
  return `JSON 형식이 맞지 않아요.${location} 중괄호, 쉼표와 따옴표가 빠지지 않았는지 확인해 주세요.`;
}

function objectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}" && --depth === 0) {
      return index + 1;
    }
  }
  return -1;
}

export function parseAgentResult(input) {
  const text = input.trim().replace(/^\uFEFF/, "");
  if (!text) throw new AgentResultError("② 응답이나 JSON을 먼저 붙여 넣어 주세요.");

  const fences = [...text.matchAll(/^[ \t]*```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*\r?$/gim)];
  if (fences.length > 1) {
    throw new AgentResultError("JSON 코드 블록이 여러 개예요. ② 결과 하나만 붙여 넣어 주세요.");
  }
  if (!fences.length && /^[ \t]*```/m.test(text)) {
    throw new AgentResultError("JSON 코드 블록의 시작과 끝이 완전한지 확인해 주세요.");
  }

  const fence = fences[0];
  let jsonText = fence ? fence[1] : text;
  let summary = fence
    ? [text.slice(0, fence.index), text.slice(fence.index + fence[0].length)].filter((part) => part.trim()).join("\n\n").trim()
    : "";
  if (!fence && !text.startsWith("{")) {
    const start = text.search(/\{\s*"/);
    if (start >= 0) {
      const end = objectEnd(text, start);
      jsonText = text.slice(start, end < 0 ? undefined : end);
      summary = [text.slice(0, start), end < 0 ? "" : text.slice(end)].filter((part) => part.trim()).join("\n\n").trim();
    }
  }
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new AgentResultError(jsonErrorMessage(error, jsonText));
  }
  validateResult(data);
  return { data, summary };
}

export function createShaftSummary(input) {
  const data = typeof input === "string" ? parseAgentResult(input).data : input?.data ?? input;
  if (!isRecord(data) || data.schema_version === "2.0") {
    return "② 분석 결과가 없어 축 도면 설명을 만들지 않았어요.";
  }

  const isShaftFeature = (feature) => {
    const type = typeof feature.type === "string" ? feature.type.trim().toLowerCase().replace(/\s+/g, "") : "";
    return ["축", "축전체", "축구간", "축지름구간", "축형상", "계단축", "shaft", "shaftsegment"].includes(type);
  };
  const shaftFeatures = (data.features ?? []).filter((feature) => {
    return isShaftFeature(feature);
  });
  if (!shaftFeatures.length) {
    return "② 분석 결과에 축으로 분류된 형상이 없어 축 도면 설명을 만들지 않았어요. 부품 종류를 확인할 수 없어요.";
  }

  const featureNames = [...new Set(
    (data.features ?? [])
      .filter((feature) => feature.needs_confirmation === false && !needsAttention(feature))
      .map((feature) => typeof feature.type === "string" ? feature.type.trim() : "")
      .filter((type) => type && !isShaftFeature({ type })),
  )];
  const elements = new Map((data.elements ?? []).map((element) => [String(element.id), element]));
  const dimensions = [];
  const seenDimensions = new Set();
  for (const feature of shaftFeatures) {
    if (needsAttention(feature)) continue;
    for (const attribute of feature.attributes ?? []) {
      if (attribute.link_status !== "연결됨") continue;
      for (const id of attribute.linked_element_ids ?? []) {
        const element = elements.get(String(id));
        if (!element || !isDimension(element) || needsAttention(element) || isBlank(element.raw_text)) continue;
        const text = `${displayValue(attribute.name, "치수")}: ${String(element.raw_text).trim()}`;
        if (seenDimensions.has(text)) continue;
        seenDimensions.add(text);
        dimensions.push(text);
        if (dimensions.length === 4) break;
      }
      if (dimensions.length === 4) break;
    }
    if (dimensions.length === 4) break;
  }

  const parts = ["② 분석 결과에는 이 도면이 축으로 분류되어 있어요."];
  if (featureNames.length) parts.push(`함께 기록된 형상: ${featureNames.slice(0, 4).join(", ")}.`);
  parts.push(dimensions.length
    ? `연결이 확인된 치수 표기: ${dimensions.join("; ")}.`
    : "축 형상과 연결이 확인된 치수 표기가 없어요.");
  const ksReferences = [...new Set(
    (data.elements ?? [])
      .filter((element) => element.category === "표준참조" && !needsAttention(element) && !isBlank(element.raw_text))
      .map((element) => String(element.raw_text).trim())
      .slice(0, 3),
  )];
  parts.push(ksReferences.length
    ? `도면에 적힌 KS 표기: ${ksReferences.join(", ")}. 이 표기만으로 규격 적합성을 판정하지 않아요.`
    : "② 분석 결과에 확인된 KS 표기가 없어 규격 적합성은 판단하지 않았어요.");

  const needsCheck = data.status !== "완료"
    || (data.source?.unanalyzed_pages?.length ?? 0) > 0
    || (data.pages ?? []).some((page) => (page.views ?? []).some((view) => view.read_coverage !== "확대 판독"))
    || (data.features ?? []).some(needsAttention)
    || (data.elements ?? []).some(needsAttention)
    || (data.stage_log ?? []).some((stage) => stage.result !== "완료");
  if (data.status === "완료" && (data.stage_log ?? []).some((stage) => stage.result !== "완료")) {
    parts.push("전체 상태는 완료지만 단계별 결과에는 확인 필요가 남아 있어요.");
  }
  if (needsCheck) parts.push("읽지 못했거나 확인이 필요한 부분이 있어 원본 도면과 대조해 주세요.");
  parts.push("이 설명은 ②의 기록을 정리한 것이며, 설계 적합성이나 KS 기준 준수는 판정하지 않아요.");
  return parts.join(" ");
}

export function displayValue(value, emptyText = "없음") {
  if (value === undefined) return "확인 필요";
  if (value === null || typeof value === "string" && !value.trim()) return emptyText;
  if (Array.isArray(value)) {
    return value.length
      ? value.map((item) => isRecord(item) || Array.isArray(item) ? JSON.stringify(item) : displayValue(item)).join(", ")
      : emptyText;
  }
  if (isRecord(value)) return JSON.stringify(value);
  return String(value);
}

function idText(value) {
  return displayValue(value, "확인 필요");
}

function isBlank(value) {
  return value == null || typeof value === "string" && !value.trim();
}

function isDimension(element) {
  const category = typeof element.category === "string" ? element.category : "";
  return category.includes("치수") && !category.includes("공차");
}

function isSpecification(element) {
  const category = typeof element.category === "string" ? element.category : "";
  return /공차|끼워맞춤|거칠기|데이텀/.test(category);
}

function needsAttention(record) {
  return record.needs_confirmation !== false || ["중간", "낮음"].includes(record.confidence);
}

function stageNumber(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = String(value ?? "").trim().match(/^([1-6])(?:단계)?$/);
  return match ? Number(match[1]) : null;
}

export function createAgentResultModel({ data, summary }) {
  const confirmations = [];
  const addConfirmation = (source, message) => confirmations.push({ source, message });
  const source = data.source ?? {};
  const pages = data.pages ?? [];
  const elements = data.elements ?? [];
  const features = data.features ?? [];
  const views = [];
  const coverage = { enlarged: 0, overview: 0, unread: 0, unknown: 0 };

  if (!data.source) addConfirmation("도면 정보", "도면 정보가 기록되지 않았어요.");
  for (const [key, label] of RESULT_LISTS) {
    if (data[key] == null) addConfirmation("전체 결과", `${label} 목록이 기록되지 않았어요.`);
  }
  if (data.schema_version !== "1.2") {
    const version = displayValue(data.schema_version, "확인 필요");
    addConfirmation("결과 형식", `버전 ${version}은 1.2와 달라 일부 항목을 확인해야 해요.`);
  }
  if (data.status !== "완료") {
    addConfirmation("전체 결과", `전체 상태: ${displayValue(data.status, "확인 필요")}`);
  }
  if (source.unanalyzed_pages == null) {
    addConfirmation("도면 정보", "분석하지 못한 페이지 목록이 기록되지 않았어요.");
  } else {
    for (const page of source.unanalyzed_pages) {
      addConfirmation("도면 정보", `${displayValue(page, "확인 필요")}페이지를 분석하지 못했어요.`);
    }
  }

  for (const page of pages) {
    const pageLabel = `${displayValue(page.page_number, "확인 필요")}페이지`;
    if (isBlank(page.page_number)) addConfirmation("페이지", "페이지 번호가 기록되지 않았어요.");
    if (!page.views?.length) {
      addConfirmation(pageLabel, "뷰 목록이 기록되지 않아 판독 범위를 확인할 수 없어요.");
    }
    for (const view of page.views ?? []) {
      views.push({ page, view });
      if (isBlank(view.id)) addConfirmation(pageLabel, "뷰 번호가 기록되지 않았어요.");
      if (view.read_coverage === "확대 판독") coverage.enlarged += 1;
      else if (view.read_coverage === "전체 이미지만") coverage.overview += 1;
      else if (view.read_coverage === "읽지 못함") coverage.unread += 1;
      else coverage.unknown += 1;
      if (view.read_coverage !== "확대 판독") {
        addConfirmation(
          `${pageLabel} · 뷰 ${idText(view.id)}`,
          `판독 범위: ${displayValue(view.read_coverage, "확인 필요")} · 위치: ${displayValue(view.location_description, "확인 필요")}`,
        );
      }
    }
  }
  if (!views.length) addConfirmation("판독 범위", "뷰가 없어 확대 판독 여부를 확인할 수 없어요.");
  if (data.status === "완료" && (coverage.overview || coverage.unread || coverage.unknown || source.unanalyzed_pages?.length)) {
    addConfirmation("전체 결과", "전체 상태는 완료지만 확대하지 못한 뷰나 분석하지 못한 페이지가 있어요.");
  }

  const elementIds = new Set();
  for (const element of elements) {
    if (isBlank(element.id)) {
      addConfirmation("읽은 요소", "요소 번호가 기록되지 않았어요.");
    } else if (elementIds.has(String(element.id))) {
      addConfirmation(`요소 ${element.id}`, "같은 요소 번호가 여러 번 기록돼 연결을 확인해야 해요.");
    } else {
      elementIds.add(String(element.id));
    }
  }
  const links = new Map();
  const featureIds = new Set();
  const featureRows = [];
  const attributeSpecifications = [];
  for (const feature of features) {
    const featureLabel = `형상 ${idText(feature.id)}`;
    if (isBlank(feature.id)) {
      addConfirmation("형상", "형상 번호가 기록되지 않았어요.");
    } else if (featureIds.has(String(feature.id))) {
      addConfirmation(featureLabel, "같은 형상 번호가 여러 번 기록돼 연결을 확인해야 해요.");
    } else {
      featureIds.add(String(feature.id));
    }
    if (!feature.view_ids?.length || feature.view_ids.some(isBlank)) {
      addConfirmation(featureLabel, "형상이 속한 뷰 번호가 기록되지 않았거나 비어 있어요.");
    }
    if (needsAttention(feature)) {
      const state = feature.needs_confirmation == null ? "확인 상태 미기록" : `확인 필요 · 신뢰도 ${displayValue(feature.confidence, "확인 필요")}`;
      addConfirmation(featureLabel, `${state} · ${displayValue(feature.description, "설명 확인 필요")}`);
    }
    if (!feature.attributes?.length) {
      featureRows.push({ feature, attribute: null });
      addConfirmation(featureLabel, "속성 목록이 기록되지 않았거나 비어 있어요.");
    }
    for (const attribute of feature.attributes ?? []) {
      featureRows.push({ feature, attribute });
      const attributeLabel = `${featureLabel} · ${displayValue(attribute.name, "속성 확인 필요")}`;
      if (isBlank(attribute.name)) addConfirmation(featureLabel, "형상 속성 이름이 기록되지 않았어요.");
      if (attribute.link_status !== "연결됨") {
        addConfirmation(attributeLabel, `연결 상태: ${displayValue(attribute.link_status, "확인 필요")} · 근거: ${displayValue(attribute.evidence, "없음")}`);
      } else if (!attribute.linked_element_ids?.length) {
        addConfirmation(attributeLabel, "연결됨으로 기록됐지만 연결된 요소 번호가 없어요.");
      }
      for (const id of attribute.linked_element_ids ?? []) {
        if (isBlank(id)) {
          addConfirmation(attributeLabel, "연결된 요소 번호가 비어 있어요.");
          continue;
        }
        const key = String(id);
        if (!links.has(key)) links.set(key, []);
        links.get(key).push({ feature, attribute });
        if (!elementIds.has(key)) {
          addConfirmation(attributeLabel, `연결된 요소 ${key}를 요소 목록에서 확인할 수 없어요.`);
        }
      }
      if (!isBlank(attribute.tolerance_text)) {
        attributeSpecifications.push({ feature, attribute });
      }
    }
  }

  for (const element of elements) {
    const elementLabel = `요소 ${idText(element.id)}`;
    if (isBlank(element.category)) addConfirmation(elementLabel, "요소 종류가 기록되지 않았어요.");
    if (isBlank(element.page_number) || isBlank(element.view_id)) {
      addConfirmation(elementLabel, "요소가 속한 페이지 또는 뷰가 기록되지 않았어요.");
    }
    if (isDimension(element) && isBlank(element.raw_text)) {
      addConfirmation(elementLabel, "치수 원문이 비어 있어 도면에서 확인해야 해요.");
    }
    if (needsAttention(element)) {
      const state = element.needs_confirmation == null ? "확인 상태 미기록" : `확인 필요 · 신뢰도 ${displayValue(element.confidence, "확인 필요")}`;
      addConfirmation(
        elementLabel,
        `${state} · 뷰 ${idText(element.view_id)} · 내용: ${displayValue(element.raw_text, "확인 필요")} · 이유: ${displayValue(element.confidence_reason, "없음")}`,
      );
    }
    if (isDimension(element) && (element.id == null || !links.has(String(element.id)))) {
      addConfirmation(elementLabel, "치수에 연결된 형상 속성 기록이 없어요.");
    }
  }

  for (const chain of data.dimension_chains ?? []) {
    const label = `치수 합계 ${idText(chain.id)}`;
    if (!chain.element_ids?.length) addConfirmation(label, "합계에 사용한 요소 번호가 기록되지 않았어요.");
    for (const id of chain.element_ids ?? []) {
      if (isBlank(id) || !elementIds.has(String(id))) {
        addConfirmation(label, `사용한 요소 ${idText(id)}를 요소 목록에서 확인할 수 없어요.`);
      }
    }
    if (!isBlank(chain.overall_element_id) && !elementIds.has(String(chain.overall_element_id))) {
      addConfirmation(label, `전체 치수 ${chain.overall_element_id}를 요소 목록에서 확인할 수 없어요.`);
    }
  }

  const groupedStages = new Map(STAGE_NAMES.map((_, index) => [index + 1, []]));
  const otherStages = [];
  for (const stage of data.stage_log ?? []) {
    const number = stageNumber(stage.stage);
    if (number) groupedStages.get(number).push(stage);
    else {
      otherStages.push(stage);
      addConfirmation("단계별 결과", `단계 번호 ${displayValue(stage.stage, "확인 필요")}를 1~6단계에 연결할 수 없어요.`);
    }
  }
  const stages = [];
  for (const [number, entries] of groupedStages) {
    if (!entries.length) {
      stages.push({ stage: number, name: STAGE_NAMES[number - 1], missing: true });
      addConfirmation(`${number}단계`, "단계 결과가 기록되지 않았어요.");
    } else {
      if (entries.length > 1) addConfirmation(`${number}단계`, `같은 단계의 결과가 ${entries.length}개 기록됐어요.`);
      stages.push(...entries);
    }
  }
  stages.push(...otherStages);
  for (const stage of stages.filter((entry) => !entry.missing)) {
    const number = displayValue(stage.stage, "확인 필요");
    const label = number.endsWith("단계") ? number : `${number}단계`;
    if (stage.result !== "완료") addConfirmation(label, `단계 상태: ${displayValue(stage.result, "확인 필요")}`);
    if (stage.issues == null) addConfirmation(label, "남은 문제 목록이 기록되지 않았어요.");
    else for (const issue of stage.issues) addConfirmation(label, displayValue(issue, "내용 확인 필요"));
  }
  const incompleteStages = stages.filter((stage) => !stage.missing && stage.result !== "완료");
  if (data.status === "완료" && incompleteStages.length) {
    addConfirmation(
      "전체 결과",
      `전체 상태는 완료지만 ${incompleteStages.map((stage) => `${displayValue(stage.stage)}단계`).join(", ")}에 확인할 내용이 남아 있어요.`,
    );
  }
  for (const limitation of data.limitations ?? []) {
    addConfirmation("판독 한계", displayValue(limitation, "내용 확인 필요"));
  }

  return {
    data,
    summary,
    source,
    coverage,
    views,
    confirmations,
    stages,
    featureRows,
    dimensions: elements.filter(isDimension),
    specifications: [
      ...elements.filter(isSpecification).map((element) => ({ element })),
      ...attributeSpecifications,
    ],
    otherElements: elements.filter((element) => !isDimension(element) && !isSpecification(element)),
    chains: data.dimension_chains ?? [],
    links,
  };
}
