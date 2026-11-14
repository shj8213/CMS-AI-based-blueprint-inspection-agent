import {
  AgentResultError,
  createAgentResultModel,
  createShaftSummary,
  displayValue,
  parseAgentResult,
} from "./agent-result.js";

const PAGE_SIZE = 50;
const $ = (selector) => document.querySelector(selector);
const requiredValue = (value) => displayValue(value, "확인 필요");
const knownList = (value) => value == null ? "확인 필요" : displayValue(value);

function confirmationState(record) {
  if (record.needs_confirmation == null) return "확인 필요 · 상태 미기록";
  if (record.needs_confirmation) return "확인 필요";
  if (["중간", "낮음"].includes(record.confidence)) return "확인 필요 · 신뢰도와 상태 기록이 달라요";
  return "확인 필요로 기록되지 않음";
}

function rawText(element) {
  return displayValue(element.raw_text, element.needs_confirmation === false ? "없음" : "확인 필요");
}

function elementLocation(element) {
  const location = element.location;
  let text = `${requiredValue(element.page_number)}페이지 · 뷰 ${requiredValue(element.view_id)}\n${requiredValue(location?.description)}`;
  if (location && (location.x != null || location.y != null)) {
    text += `\n좌표: (${requiredValue(location.x)}, ${requiredValue(location.y)}) · 단위: ${requiredValue(location.coordinate_unit)} · 좌표계: ${requiredValue(location.coordinate_system)}`;
  }
  if (location?.bbox != null) text += `\n범위: ${displayValue(location.bbox)}`;
  return text;
}

function renderTable(container, label, columns, rows, emptyMessage) {
  container.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "agent-empty";
    empty.textContent = emptyMessage;
    container.append(empty);
    return;
  }

  const scroll = document.createElement("div");
  scroll.className = "table-scroll";
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.className = "hidden-input";
  caption.textContent = label;
  const head = document.createElement("thead");
  const headings = document.createElement("tr");
  for (const column of columns) {
    const heading = document.createElement("th");
    heading.scope = "col";
    heading.textContent = column.label;
    headings.append(heading);
  }
  head.append(headings);
  const body = document.createElement("tbody");
  table.append(caption, head, body);
  scroll.append(table);

  const navigation = document.createElement("div");
  navigation.className = "result-navigation";
  const previous = document.createElement("button");
  previous.type = "button";
  previous.className = "select-button";
  previous.id = `${container.id}-previous`;
  previous.textContent = "이전 목록";
  previous.setAttribute("aria-label", `${label} 이전 목록`);
  const range = document.createElement("span");
  range.id = `${container.id}-range`;
  range.setAttribute("role", "status");
  const next = document.createElement("button");
  next.type = "button";
  next.className = "select-button";
  next.id = `${container.id}-next`;
  next.textContent = "다음 목록";
  next.setAttribute("aria-label", `${label} 다음 목록`);
  navigation.append(previous, range, next);
  container.append(scroll, navigation);

  let offset = 0;
  function showPage() {
    const fragment = document.createDocumentFragment();
    for (const row of rows.slice(offset, offset + PAGE_SIZE)) {
      const tr = document.createElement("tr");
      for (const column of columns) {
        const cell = document.createElement("td");
        cell.textContent = column.text(row);
        tr.append(cell);
      }
      fragment.append(tr);
    }
    body.replaceChildren(fragment);
    range.textContent = `${offset + 1}–${Math.min(offset + PAGE_SIZE, rows.length)} / ${rows.length}개`;
    previous.disabled = offset === 0;
    next.disabled = offset + PAGE_SIZE >= rows.length;
  }
  previous.addEventListener("click", () => {
    offset = Math.max(0, offset - PAGE_SIZE);
    showPage();
  });
  next.addEventListener("click", () => {
    offset += PAGE_SIZE;
    showPage();
  });
  showPage();
}

function renderSummary(summary, selector = "#agent-summary", emptyMessage = "총 분석 문장이 없어요. 아래의 읽은 내용과 확인할 내용을 살펴봐 주세요.") {
  const container = $(selector);
  if (!summary) {
    container.textContent = emptyMessage;
    return;
  }
  const plainText = (text) => text.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  const lines = summary.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.every((line) => /^[-*]\s+/.test(line))) {
    container.textContent = plainText(summary);
    return;
  }
  const list = document.createElement("ul");
  for (const line of lines) {
    const item = document.createElement("li");
    const content = line.replace(/^[-*]\s+/, "");
    const heading = content.match(/^\*\*([^*\n]+)\*\*(.*)$/);
    if (heading) {
      const label = document.createElement("strong");
      label.textContent = heading[1];
      item.append(label, document.createTextNode(plainText(heading[2])));
    } else {
      item.textContent = plainText(content);
    }
    list.append(item);
  }
  container.replaceChildren(list);
}

function addReviewField(container, label, value, emptyText = "확인 필요") {
  const row = document.createElement("p");
  const name = document.createElement("strong");
  name.textContent = `${label}: `;
  row.append(name, document.createTextNode(displayValue(value, emptyText)));
  container.append(row);
}

function renderReviewList(container, records, emptyMessage, renderRecord) {
  container.replaceChildren();
  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "agent-empty";
    empty.textContent = emptyMessage;
    container.append(empty);
    return;
  }
  for (const record of records) container.append(renderRecord(record));
}

function renderReviewResult(data, responseSummary, message, analysisText) {
  $("#agent-result-title").textContent = "③ 도면 검토 결과";
  $("#result-title").textContent = "③ 도면 검토 결과";
  const analysisDetails = $("#analysis-result-details");
  analysisDetails.hidden = true;
  $("#agent-result-output").hidden = true;
  if (analysisText) {
    try {
      const analysis = parseAgentResult(analysisText);
      if (analysis.data.schema_version !== "2.0") {
        renderResult(createAgentResultModel(analysis));
        analysisDetails.hidden = false;
        analysisDetails.open = false;
      }
    } catch (error) {
      if (!(error instanceof AgentResultError)) throw error;
    }
  }
  $("#agent-result-title").textContent = "③ 도면 검토 결과";
  $("#result-title").textContent = "③ 도면 검토 결과";
  $("#review-agent-result-output").hidden = false;
  let shaftSummary = "② 분석 결과가 제공되지 않아 축 도면 설명을 만들지 않았어요.";
  if (analysisText) {
    try {
      shaftSummary = createShaftSummary(analysisText);
    } catch (error) {
      if (!(error instanceof AgentResultError)) throw error;
      shaftSummary = "② 분석 결과 형식을 읽지 못해 축 도면 설명을 만들지 않았어요.";
    }
  }
  $("#shaft-analysis-summary").textContent = shaftSummary;
  $("#review-agent-status").textContent = data.status;
  $("#review-agent-basis").textContent = data.review_basis;
  $("#review-agent-pages").textContent =
    `확인함: ${displayValue(data.reviewed_pages, "기록 없음")} · 확인하지 못함: ${displayValue(data.unreviewed_pages, "없음")}`;
  $("#review-agent-human-status").textContent = data.human_review_status;
  renderSummary(
    data.summary || responseSummary,
    "#review-agent-summary",
    "요약이 없어요. 아래 지적과 남은 한계를 확인해 주세요.",
  );

  $("#review-agent-finding-count").textContent = `(${data.findings.length}개)`;
  renderReviewList(
    $("#review-agent-findings"),
    data.findings,
    "기록된 지적이 없어요. 원본 도면과 직접 비교해 주세요.",
    (finding) => {
      const card = document.createElement("article");
      card.className = "review-finding";
      const heading = document.createElement("h4");
      heading.textContent = `${finding.classification} · ${finding.issue_type} · ${finding.id}`;
      card.append(heading);
      addReviewField(card, "② 항목 ID", finding.analysis_item_ids.join(", "), "없음");
      addReviewField(card, "위치", finding.location);
      addReviewField(card, "무엇이 문제인지", finding.what);
      addReviewField(card, "왜 확인해야 하는지", finding.why);
      addReviewField(card, "근거", finding.basis);
      addReviewField(card, "어떻게 확인할지", finding.how_to_resolve);
      addReviewField(card, "확인한 내용", finding.evidence);
      if (finding.intent_hypothesis) {
        addReviewField(
          card,
          "가능한 의도(추정)",
          finding.intent_hypothesis.replace(/^(?:가능한 의도\(추정\):\s*)+/, ""),
        );
      }
      addReviewField(card, "판단 근거·신뢰도", `${finding.confidence} · ${finding.confidence_reason}`);
      addReviewField(card, "다음 확인", finding.next_check, "더 확인할 내용 없음");
      return card;
    },
  );

  $("#review-agent-not-missing-count").textContent = `(${data.not_missing.length}개)`;
  renderReviewList(
    $("#review-agent-not-missing"),
    data.not_missing,
    "이미 확인된 정보가 따로 기록되지 않았어요.",
    (record) => {
      const card = document.createElement("article");
      card.className = "review-finding";
      addReviewField(card, "확인된 정보", record.item);
      addReviewField(card, "② 항목 ID", record.analysis_item_ids.join(", "), "없음");
      addReviewField(card, "위치", record.location);
      addReviewField(card, "누락이 아닌 이유", record.reason);
      return card;
    },
  );

  $("#review-agent-limitations-count").textContent = `(${data.limitations.length}개)`;
  renderReviewList(
    $("#review-agent-limitations"),
    data.limitations,
    "기록된 한계가 없어요. 원본 도면과 직접 비교해 주세요.",
    (limitation) => {
      const item = document.createElement("p");
      item.className = "agent-empty";
      item.textContent = limitation;
      return item;
    },
  );
  return message.includes("직접")
    ? "직접 입력한 ③ 검토 결과를 표시했어요."
    : "③ 검토 응답을 표시했어요.";
}

function renderResult(model) {
  const { data, source, coverage } = model;
  $("#agent-result-title").textContent = "② 도면 분석 결과";
  $("#result-title").textContent = "② 도면 분석 결과";
  $("#analysis-result-details").hidden = false;
  $("#analysis-result-details").open = false;
  $("#review-agent-result-output").hidden = true;
  $("#agent-result-output").hidden = false;
  const summary = model.summary.replace(/^(?:#{1,6}\s*)?(?:\*\*)?총 분석(?:\*\*)?[ \t]*[:：]?[ \t]*(?:\r?\n|$)/, "").trim();
  renderSummary(summary);
  $("#agent-status").textContent = requiredValue(data.status);
  $("#agent-file-name").textContent = requiredValue(source.file_name);
  $("#agent-pages").textContent = `전체: ${requiredValue(source.page_count)} · 분석함: ${knownList(source.analyzed_pages)} · 분석하지 못함: ${knownList(source.unanalyzed_pages)}`;
  $("#agent-coverage").textContent = model.views.length
    ? `확대 판독 ${coverage.enlarged} · 전체 이미지만 ${coverage.overview} · 읽지 못함 ${coverage.unread} · 미기록·기타 ${coverage.unknown}`
    : "확인 필요 · 뷰 기록 없음";
  $("#agent-confirmation-count").textContent = `${model.confirmations.length}개`;

  renderTable($("#agent-confirmations"), "확인 필요 항목", [
    { label: "출처", text: (row) => row.source },
    { label: "확인할 내용", text: (row) => row.message },
  ], model.confirmations, "없음 · 결과에 확인 필요로 기록된 항목은 없지만 원본 도면과 직접 비교해 주세요.");

  renderTable($("#agent-stages"), "단계별 결과", [
    { label: "단계", text: (row) => requiredValue(row.stage) },
    { label: "이름", text: (row) => requiredValue(row.name) },
    { label: "결과", text: (row) => row.missing ? "확인 필요 · 기록 없음" : requiredValue(row.result) },
    { label: "점검 내용", text: (row) => requiredValue(row.checked) },
    { label: "남은 문제", text: (row) => knownList(row.issues) },
  ], model.stages, "확인 필요 · 단계별 기록이 없어요.");

  $("#agent-view-count").textContent = `(${model.views.length}개)`;
  renderTable($("#agent-views"), "뷰별 판독 범위", [
    { label: "페이지", text: (row) => requiredValue(row.page.page_number) },
    { label: "뷰 번호·종류", text: (row) => `${requiredValue(row.view.id)} · ${requiredValue(row.view.type)}` },
    { label: "위치", text: (row) => requiredValue(row.view.location_description) },
    { label: "판독 범위", text: (row) => requiredValue(row.view.read_coverage) },
  ], model.views, "없음 · 뷰가 기록되지 않아 판독 범위를 확인할 수 없어요.");

  const featureCount = data.features == null ? "확인 필요" : `${data.features.length}개`;
  $("#agent-feature-count").textContent = `(형상 ${featureCount} · 속성 행 ${model.featureRows.length}개)`;
  renderTable($("#agent-features"), "형상과 속성", [
    { label: "형상 번호·종류", text: ({ feature }) => `${requiredValue(feature.id)} · ${requiredValue(feature.type)}` },
    { label: "설명·뷰", text: ({ feature }) => `${requiredValue(feature.description)}\n뷰: ${knownList(feature.view_ids)}` },
    { label: "속성", text: ({ feature, attribute }) => attribute ? requiredValue(attribute.name) : feature.attributes == null ? "확인 필요" : "없음" },
    { label: "연결 상태·요소", text: ({ attribute }) => attribute
      ? `${requiredValue(attribute.link_status)}\n요소: ${knownList(attribute.linked_element_ids)}` : "확인 필요" },
    { label: "공차·계산식", text: ({ attribute }) => attribute
      ? `공차: ${displayValue(attribute.tolerance_text)}\n계산: ${displayValue(attribute.derivation)}` : "확인 필요" },
    { label: "확인 상태·근거", text: ({ feature, attribute }) => `${confirmationState(feature)}\n근거: ${attribute ? displayValue(attribute.evidence) : "확인 필요"}` },
  ], model.featureRows, data.features == null ? "확인 필요 · 형상 목록이 기록되지 않았어요." : "없음 · 기록된 형상이 없어요.");

  $("#agent-dimension-count").textContent = `(${model.dimensions.length}개)`;
  renderTable($("#agent-dimensions"), "치수와 형상 연결", [
    { label: "요소 번호", text: (element) => requiredValue(element.id) },
    { label: "원문·값", text: (element) => `${rawText(element)}\n값: ${displayValue(element.value)} · 단위: ${displayValue(element.unit)}` },
    { label: "위치", text: elementLocation },
    { label: "연결된 형상·상태", text: (element) => {
      const links = element.id == null ? [] : model.links.get(String(element.id)) ?? [];
      return links.length ? links.map(({ feature, attribute }) =>
        `${requiredValue(feature.id)} · ${requiredValue(feature.type)} · ${requiredValue(attribute.name)}: ${requiredValue(attribute.link_status)}`).join("\n")
        : "연결 기록 없음 · 확인 필요";
    } },
    { label: "확인 상태·근거", text: (element) => `${confirmationState(element)}\n근거: ${displayValue(element.evidence)}` },
  ], model.dimensions, data.elements == null ? "확인 필요 · 요소 목록이 기록되지 않았어요." : "없음 · 기록된 치수가 없어요.");

  $("#agent-specification-count").textContent = `(${model.specifications.length}개)`;
  renderTable($("#agent-specifications"), "공차·기하공차·표면거칠기", [
    { label: "종류·출처", text: (row) => row.element
      ? `${requiredValue(row.element.category)} · ${requiredValue(row.element.id)}`
      : `형상 속성 공차 · ${requiredValue(row.feature.id)} · ${requiredValue(row.attribute.name)}` },
    { label: "원문·값", text: (row) => row.element
      ? `${rawText(row.element)}\n값: ${displayValue(row.element.value)} · 단위: ${displayValue(row.element.unit)}`
      : requiredValue(row.attribute.tolerance_text) },
    { label: "위치", text: (row) => row.element ? elementLocation(row.element) : `뷰: ${knownList(row.feature.view_ids)}` },
    { label: "확인 상태·근거", text: (row) => row.element
      ? `${confirmationState(row.element)}\n근거: ${displayValue(row.element.evidence)}`
      : `${requiredValue(row.attribute.link_status)}\n근거: ${displayValue(row.attribute.evidence)}` },
  ], model.specifications, data.elements == null || data.features == null
    ? "확인 필요 · 요소 또는 형상 목록이 기록되지 않았어요." : "없음 · 기록된 공차·거칠기 항목이 없어요.");

  $("#agent-other-count").textContent = `(${model.otherElements.length}개)`;
  renderTable($("#agent-other-elements"), "표제란·주기 및 기타 요소", [
    { label: "종류·번호", text: (element) => `${requiredValue(element.category)} · ${requiredValue(element.id)}` },
    { label: "원문·값", text: (element) => `${rawText(element)}\n값: ${displayValue(element.value)} · 단위: ${displayValue(element.unit)}` },
    { label: "위치", text: elementLocation },
    { label: "확인 상태·근거", text: (element) => `${confirmationState(element)}\n근거: ${displayValue(element.evidence)}` },
  ], model.otherElements, data.elements == null ? "확인 필요 · 요소 목록이 기록되지 않았어요." : "없음 · 기록된 항목이 없어요.");

  $("#agent-chain-count").textContent = `(${model.chains.length}개)`;
  renderTable($("#agent-chains"), "치수 합계 기록", [
    { label: "번호·뷰", text: (chain) => `${requiredValue(chain.id)} · 뷰 ${requiredValue(chain.view_id)}` },
    { label: "방향·요소", text: (chain) => `${requiredValue(chain.direction)}\n요소: ${knownList(chain.element_ids)}` },
    { label: "합계·전체 치수·차이", text: (chain) =>
      `합계: ${displayValue(chain.sum)}\n전체 치수: ${displayValue(chain.overall_element_id)}\n차이: ${displayValue(chain.difference)}` },
    { label: "설명", text: (chain) => displayValue(chain.note) },
  ], model.chains, data.dimension_chains == null ? "확인 필요 · 치수 합계 목록이 기록되지 않았어요." : "없음 · 기록된 치수 합계가 없어요.");
}

export function createAgentResultView() {
  const panel = $("#agent-result-panel");
  const input = $("#agent-result-input");
  const button = $("#agent-result-show");
  const saveButton = $("#agent-result-save");
  const output = $("#agent-result-output");
  const reviewOutput = $("#review-agent-result-output");
  const error = $("#agent-result-error");
  const progress = $("#agent-result-progress");
  let generation = 0;

  function showResult(text, message, analysisText) {
    const parsed = parseAgentResult(text);
    if (parsed.data.schema_version === "2.0") {
      progress.textContent = renderReviewResult(parsed.data, parsed.summary, message, analysisText);
      return;
    }
    renderResult(createAgentResultModel(parsed));
    output.hidden = false;
    progress.textContent = message;
  }

  input.addEventListener("input", () => {
    error.textContent = "";
    saveButton.hidden = true;
    saveButton.disabled = true;
    if (!output.hidden || !reviewOutput.hidden) {
      output.hidden = true;
      reviewOutput.hidden = true;
      $("#analysis-result-details").hidden = true;
      $("#analysis-result-details").open = false;
      $("#agent-result-title").textContent = "② 도면 분석 결과";
      $("#result-title").textContent = "② 분석 결과";
      progress.textContent = "입력이 바뀌었어요. 결과 보기를 다시 눌러 주세요.";
    }
  });

  button.addEventListener("click", async () => {
    const currentGeneration = ++generation;
    const text = input.value;
    output.hidden = true;
    reviewOutput.hidden = true;
    $("#analysis-result-details").hidden = true;
    $("#analysis-result-details").open = false;
    error.textContent = "";
    progress.textContent = "결과를 정리하는 중이에요…";
    panel.setAttribute("aria-busy", "true");
    button.disabled = true;
    input.disabled = true;
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (currentGeneration !== generation) return;
    try {
      showResult(text, "직접 입력한 결과를 표시했어요.");
      saveButton.hidden = false;
      saveButton.disabled = false;
    } catch (caught) {
      if (caught instanceof AgentResultError) {
        error.textContent = caught.message;
      } else {
        console.error("② 분석 결과 표시 실패:", caught instanceof Error ? caught.name : typeof caught);
        error.textContent = "결과를 표시하는 중 예상하지 못한 오류가 났어요. 입력을 확인한 뒤 다시 시도해 주세요.";
      }
      progress.textContent = "";
      saveButton.hidden = true;
      saveButton.disabled = true;
    } finally {
      if (currentGeneration === generation) {
        panel.setAttribute("aria-busy", "false");
        button.disabled = false;
        input.disabled = false;
      }
    }
  });

  return {
    showResponse(text, analysisText = null) {
      error.textContent = "";
      showResult(text, "②의 응답을 표시했어요.", analysisText);
    },
    openManual() {
      $("#agent-manual").open = true;
    },
    reset() {
      generation += 1;
      for (const details of panel.querySelectorAll("details")) details.open = false;
      input.value = "";
      input.disabled = false;
      button.disabled = false;
      saveButton.hidden = true;
      saveButton.disabled = true;
      output.hidden = true;
      reviewOutput.hidden = true;
      $("#analysis-result-details").hidden = true;
      $("#agent-result-title").textContent = "② 도면 분석 결과";
      $("#result-title").textContent = "② 분석 결과";
      error.textContent = "";
      progress.textContent = "";
      panel.setAttribute("aria-busy", "false");
      for (const selector of [
        "#agent-summary", "#agent-status", "#agent-file-name", "#agent-pages", "#agent-coverage",
        "#agent-confirmation-count", "#agent-view-count", "#agent-feature-count", "#agent-dimension-count",
        "#agent-specification-count", "#agent-other-count", "#agent-chain-count",
        "#agent-confirmations", "#agent-stages", "#agent-views", "#agent-features",
        "#agent-dimensions", "#agent-specifications", "#agent-other-elements", "#agent-chains",
        "#review-agent-status", "#review-agent-basis", "#review-agent-pages", "#review-agent-human-status",
        "#shaft-analysis-summary",
        "#review-agent-summary", "#review-agent-finding-count", "#review-agent-findings",
        "#review-agent-not-missing-count", "#review-agent-not-missing",
        "#review-agent-limitations-count", "#review-agent-limitations",
      ]) $(selector).replaceChildren();
    },
  };
}
