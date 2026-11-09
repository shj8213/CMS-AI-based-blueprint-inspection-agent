import { readDxf } from "./dxf.js";
import { readPdf } from "./pdf.js";
import { AgentResultError } from "./agent-result.js";
import { createAgentResultView } from "./agent-result-view.js";
import { analyzeDrawingWithStudio, StudioConnectionError } from "./studio-connection.js";
import { createAnalysisHistory, fileFingerprint } from "./analysis-history.js";
import { buildReferenceExamples, REFERENCE_FILE_NAME } from "./reference-examples.js";

const $ = (selector) => document.querySelector(selector);
const agentResultView = createAgentResultView();
const historyName = new URLSearchParams(window.location.search).get("history");
const analysisHistory = createAnalysisHistory({
  key: historyName === "test" ? "blueprint-analysis-history-test" : "blueprint-analysis-history-v1",
});
const savedTime = (value) => new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const fileInput = $("#file-input");
const startButton = $("#start-button");
const agentStartButton = $("#agent-start-button");
const cancelAgentButton = $("#cancel-agent");
const dropArea = $("#drop-area");
const pageSelect = $("#page-select");
const list = $("#element-list");
const preview = $("#drawing-preview");
const TABLE_SIZE = 100;
let chosenFile = null;
let busy = false;
let result = null;
let offset = 0;
let agentController = null;
let chosenFingerprint = null;
let fileToken = 0;

const number = (value) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 3 }).format(value);
const point = (value) => `(${number(value.x)}, ${number(value.y)})`;

function setBusy(value, kind = null) {
  busy = value;
  $("#upload-screen").setAttribute("aria-busy", String(value));
  startButton.disabled = value || !chosenFile;
  agentStartButton.disabled = value || !chosenFile;
  $("#select-button").disabled = value;
  $("#agent-result-only").disabled = value;
  fileInput.disabled = value;
  $("#remove-file")?.toggleAttribute("disabled", value);
  startButton.textContent = value && kind === "local" ? "읽는 중…" : "이 브라우저에서만 읽기";
  agentStartButton.textContent = value && kind === "agent" ? "② 분석 중…" : "②로 도면 분석하기";
  cancelAgentButton.hidden = !value || kind !== "agent";
  cancelAgentButton.disabled = false;
  for (const button of document.querySelectorAll("#history-panel button, #history-panel input, #open-saved-match")) button.disabled = value;
  if (!value) updateReferenceButton();
}

function hideSavedMatch() {
  $("#saved-match").hidden = true;
  $("#saved-match-text").textContent = "";
}

async function checkSavedMatch(file) {
  const token = ++fileToken;
  chosenFingerprint = null;
  hideSavedMatch();
  if (!file || !file.name.toLowerCase().endsWith(".pdf") || !file.size) return;
  let fingerprint;
  try {
    fingerprint = await fileFingerprint(file);
  } catch (error) {
    console.error("도면 구분값 계산 실패:", error instanceof Error ? error.name : typeof error);
    return;
  }
  if (token !== fileToken || file !== chosenFile) return;
  chosenFingerprint = fingerprint;
  const entry = analysisHistory.find(fingerprint);
  if (!entry) return;
  $("#saved-match-text").textContent =
    `이 도면은 ${savedTime(entry.savedAt)}에 분석한 결과가 저장되어 있어요. 다시 기다리지 않고 바로 볼 수 있어요.`;
  $("#open-saved-match").dataset.id = entry.id;
  $("#saved-match").hidden = false;
}

function updateReferenceButton() {
  const count = analysisHistory.list().filter((entry) => entry.verified).length;
  const button = $("#download-references");
  button.textContent = `참고 예제 파일 내려받기 (${count}개)`;
  button.disabled = busy || !count;
}

function downloadReferences() {
  const { count, text } = buildReferenceExamples(analysisHistory.list());
  if (!count) {
    $("#reference-status").textContent = "확인 완료로 체크한 결과 중 읽을 수 있는 것이 없어요.";
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = REFERENCE_FILE_NAME;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  $("#reference-status").textContent =
    `참고 예제 ${count}개를 ${REFERENCE_FILE_NAME} 파일로 내려받았어요. 열어서 내용을 확인한 뒤 Studio에 올려 주세요.`;
}

function renderHistory() {
  const entries = analysisHistory.list();
  $("#history-panel").hidden = !entries.length;
  $("#reference-status").textContent = "";
  updateReferenceButton();
  $("#history-list").replaceChildren(...entries.map((entry) => {
    const item = document.createElement("li");
    item.className = "file-row";
    const type = document.createElement("span");
    type.className = "file-type";
    type.textContent = "②";
    const info = document.createElement("div");
    info.className = "file-info";
    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = entry.fileName;
    const time = document.createElement("div");
    time.className = "file-size";
    time.textContent = `저장: ${savedTime(entry.savedAt)}`;
    info.append(name, time);
    const verifyLabel = document.createElement("label");
    verifyLabel.className = "verify-label";
    const verify = document.createElement("input");
    verify.type = "checkbox";
    verify.checked = Boolean(entry.verified);
    verify.disabled = busy;
    verify.setAttribute("aria-label", `${entry.fileName} 결과 확인 완료`);
    verify.addEventListener("change", () => {
      if (!analysisHistory.setVerified(entry.id, verify.checked)) {
        verify.checked = !verify.checked;
        $("#reference-status").textContent = "확인 표시를 저장하지 못했어요. 다시 시도해 주세요.";
        return;
      }
      $("#reference-status").textContent = "";
      updateReferenceButton();
    });
    verifyLabel.append(verify, "확인 완료");
    const open = document.createElement("button");
    open.className = "select-button";
    open.type = "button";
    open.textContent = "결과 보기";
    open.setAttribute("aria-label", `${entry.fileName} 저장된 결과 보기`);
    open.disabled = busy;
    open.addEventListener("click", () => openSaved(entry.id));
    const remove = document.createElement("button");
    remove.className = "remove-button";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `${entry.fileName} 저장된 결과 삭제`);
    remove.disabled = busy;
    remove.addEventListener("click", () => {
      analysisHistory.remove(entry.id);
      renderHistory();
      if ($("#open-saved-match").dataset.id === entry.id) hideSavedMatch();
    });
    item.append(type, info, verifyLabel, open, remove);
    return item;
  }));
}

function openSaved(id) {
  if (busy) return;
  const entry = analysisHistory.get(id);
  $("#read-error").textContent = "";
  if (!entry) {
    $("#read-error").textContent = "저장된 결과를 찾지 못했어요. 이미 삭제됐을 수 있어요.";
    hideSavedMatch();
    renderHistory();
    return;
  }
  try {
    agentResultView.reset();
    agentResultView.showResponse(entry.response);
  } catch (error) {
    agentResultView.reset();
    analysisHistory.remove(entry.id);
    renderHistory();
    hideSavedMatch();
    $("#read-error").textContent = "저장된 결과를 읽을 수 없어 목록에서 지웠어요. 도면을 다시 분석해 주세요.";
    console.error("저장된 결과 열기 실패:", error instanceof Error ? error.name : typeof error);
    return;
  }
  showReview(false, entry.fileName);
  $("#agent-result-progress").textContent =
    `${savedTime(entry.savedAt)}에 저장된 결과예요. 다시 분석하지 않고 바로 열었어요.`;
}

function showFile(file) {
  if (busy) return;
  $("#read-error").textContent = "";
  $("#read-progress").textContent = "";
  const extension = file.name.split(".").pop().toLowerCase();
  chosenFile = ["dxf", "pdf"].includes(extension) ? file : null;
  if (!chosenFile) {
    fileInput.value = "";
    $("#read-error").textContent = "DXF 또는 PDF 파일을 선택해 주세요.";
  }
  renderFile();
  checkSavedMatch(chosenFile);
}

function renderFile() {
  const container = $("#file-list");
  container.replaceChildren();
  startButton.disabled = busy || !chosenFile;
  agentStartButton.disabled = busy || !chosenFile;
  if (!chosenFile) return;
  const row = document.createElement("div");
  row.className = "file-row";
  const type = document.createElement("span");
  type.className = "file-type";
  type.textContent = chosenFile.name.split(".").pop().toUpperCase();
  const info = document.createElement("div");
  info.className = "file-info";
  const name = document.createElement("div");
  name.className = "file-name";
  name.textContent = chosenFile.name;
  const size = document.createElement("div");
  size.className = "file-size";
  size.textContent = `파일 크기 ${number(chosenFile.size / 1024)}킬로바이트`;
  info.append(name, size);
  const remove = document.createElement("button");
  remove.id = "remove-file";
  remove.className = "remove-button";
  remove.type = "button";
  remove.textContent = "×";
  remove.setAttribute("aria-label", "선택한 파일 지우기");
  remove.addEventListener("click", () => {
    chosenFile = null;
    fileInput.value = "";
    $("#read-error").textContent = "";
    checkSavedMatch(null);
    renderFile();
  });
  row.append(type, info, remove);
  container.append(row);
}

function summary(elements) {
  return [["line", "선"], ["circle", "원"], ["text", "글자"]]
    .map(([kind, label]) => `${label} ${elements.filter((element) => element.kind === kind).length}개`).join(" · ");
}

function renderResult() {
  $("#selected-file-name").textContent = `선택한 도면: ${chosenFile.name}`;
  $("#reading-summary").textContent = `${result.format} 읽기 결과 · ${summary(result.elements)} · 도면의 정확성을 판단한 결과는 아니에요.`;
  $("#coordinate-note").textContent = result.format === "PDF"
    ? `위치: 각 페이지의 왼쪽 위가 (0, 0), 오른쪽·아래쪽이 +방향이에요. 단위: ${result.unit}. 글자는 시작 기준점이에요.`
    : `위치: DXF 원본 좌표이며 오른쪽·위쪽이 +방향이에요. 단위: ${result.unit}. 글자는 삽입점이에요.`;
  $("#reading-warnings").replaceChildren(...result.warnings.map((message) => {
    const item = document.createElement("li");
    item.textContent = message;
    return item;
  }));
  pageSelect.replaceChildren(...result.pages.map((page) => {
    const option = document.createElement("option");
    option.value = page.number;
    option.textContent = result.format === "PDF" ? `${page.number}페이지` : "모형 공간";
    return option;
  }));
  $("#page-label").textContent = result.format === "PDF" ? "페이지" : "도면";
  offset = 0;
  renderPage();
}

function showReview(hasDrawing, agentFileName = null) {
  $(".reading-results").hidden = !hasDrawing;
  $(".review-layout").hidden = !hasDrawing;
  $("#result-title").textContent = hasDrawing ? "도면 읽기 결과" : "② 분석 결과";
  $("#back-button").textContent = hasDrawing ? "도면 다시 선택" : "처음으로";
  if (!hasDrawing) {
    $("#selected-file-name").textContent = agentFileName
      ? `선택한 도면: ${agentFileName}` : "선택한 도면 없이 직접 입력한 결과만 보여줘요.";
  }
  $("#upload-screen").hidden = true;
  $("#review-screen").hidden = false;
  $("#result-title").focus();
  window.scrollTo({ top: 0 });
}

function renderPage() {
  const page = Number(pageSelect.value);
  const elements = result.elements.filter((element) => result.format === "DXF" || element.page === page);
  $("#page-summary").textContent = elements.length ? summary(elements) : "확인 필요: 이 페이지에서 읽어낸 요소가 없어요.";
  renderTable(elements);
  renderPreview(elements, result.pages.find((entry) => entry.number === page));
}

function renderTable(elements) {
  const rows = elements.slice(offset, offset + TABLE_SIZE).map((element) => {
    let content;
    let location;
    if (element.kind === "line") {
      content = `길이 ${number(Math.hypot(element.end.x - element.start.x, element.end.y - element.start.y))}`;
      location = `시작 ${point(element.start)} → 끝 ${point(element.end)}`;
    } else if (element.kind === "circle") {
      content = `반지름 ${number(element.radius)}`;
      location = `중심 ${point(element.center)}`;
    } else {
      content = element.text;
      location = `기준점 ${point(element.position)} · 각도 ${number(element.rotation)}°`;
    }
    const row = document.createElement("tr");
    const state = element.source === "ocr"
      ? `확인 필요 · OCR ${Math.round(element.confidence)}%`
      : element.source === "image" ? "확인 필요 · 이미지에서 찾음"
      : element.uncertain ? "확인 필요" : "파일에서 읽음";
    for (const text of [
      { line: "선", circle: "원", text: "글자" }[element.kind], content, location, state,
    ]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    return row;
  });
  list.replaceChildren(...rows);
  $("#result-range").textContent = elements.length
    ? `${offset + 1}–${Math.min(offset + TABLE_SIZE, elements.length)} / ${elements.length}개`
    : "0개";
  $("#previous-results").disabled = offset === 0;
  $("#next-results").disabled = offset + TABLE_SIZE >= elements.length;
}

function renderPreview(elements, page) {
  preview.replaceChildren();
  const flip = result.format === "DXF" ? -1 : 1;
  let minX = result.format === "PDF" ? 0 : Infinity;
  let minY = result.format === "PDF" ? 0 : Infinity;
  let maxX = page.width ?? -Infinity;
  let maxY = page.height ?? -Infinity;
  function include(x, y) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  function svg(tag, attributes) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  }
  for (const element of elements) {
    let shape;
    if (element.kind === "line") {
      const y1 = flip * element.start.y;
      const y2 = flip * element.end.y;
      shape = svg("line", { x1: element.start.x, y1, x2: element.end.x, y2 });
      include(element.start.x, y1);
      include(element.end.x, y2);
    } else if (element.kind === "circle") {
      const { x, y } = element.center;
      shape = svg("circle", { cx: x, cy: flip * y, r: element.radius });
      include(x - element.radius, flip * y - element.radius);
      include(x + element.radius, flip * y + element.radius);
    } else {
      const { x, y } = element.position;
      const height = element.height || 12;
      const rotation = flip * element.rotation;
      shape = svg("text", { x, y: flip * y, "font-size": height, transform: `rotate(${rotation} ${x} ${flip * y})` });
      shape.textContent = element.text;
      const width = Array.from(element.text).length * height;
      for (const [dx, dy] of [[0, 0], [width, 0], [0, -height], [width, -height]]) {
        const angle = rotation * Math.PI / 180;
        include(x + dx * Math.cos(angle) - dy * Math.sin(angle), flip * y + dx * Math.sin(angle) + dy * Math.cos(angle));
      }
    }
    if (element.uncertain) shape.classList.add("uncertain");
    preview.append(shape);
  }
  if (!Number.isFinite(minX)) {
    minX = minY = 0;
    maxX = maxY = 100;
  }
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const padding = Math.max(width, height) * 0.05;
  preview.setAttribute("viewBox", `${minX - padding} ${minY - padding} ${width + padding * 2} ${height + padding * 2}`);
}

$("#select-button").addEventListener("click", () => fileInput.click());
$("#agent-result-only").addEventListener("click", () => {
  if (!busy) {
    agentResultView.openManual();
    showReview(false);
  }
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) showFile(fileInput.files[0]);
});
dropArea.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (!busy) dropArea.classList.add("dragging");
});
dropArea.addEventListener("dragleave", () => dropArea.classList.remove("dragging"));
dropArea.addEventListener("drop", (event) => {
  event.preventDefault();
  dropArea.classList.remove("dragging");
  if (busy) return;
  if (event.dataTransfer.files.length !== 1) {
    $("#read-error").textContent = "파일은 한 번에 하나만 선택해 주세요.";
    return;
  }
  showFile(event.dataTransfer.files[0]);
});
startButton.addEventListener("click", async () => {
  if (!chosenFile || busy) return;
  setBusy(true, "local");
  $("#read-error").textContent = "";
  $("#read-progress").textContent = "파일 읽는 중…";
  result = null;
  list.replaceChildren();
  preview.replaceChildren();
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const buffer = await chosenFile.arrayBuffer();
    if (!buffer.byteLength) throw new Error("빈 파일이에요. 내용이 있는 DXF 또는 PDF를 선택해 주세요.");
    result = chosenFile.name.toLowerCase().endsWith(".dxf")
      ? readDxf(buffer)
      : await readPdf(buffer, (message) => { $("#read-progress").textContent = message; });
    renderResult();
    showReview(true);
  } catch (error) {
    result = null;
    console.error("도면 읽기 실패:", error);
    $("#read-error").textContent = `읽지 못했어요. ${error.message}`;
  } finally {
    $("#read-progress").textContent = "";
    setBusy(false);
  }
});
agentStartButton.addEventListener("click", async () => {
  if (!chosenFile || busy) return;
  const file = chosenFile;
  agentController = new AbortController();
  setBusy(true, "agent");
  $("#read-error").textContent = "";
  try {
    const response = await analyzeDrawingWithStudio(file, {
      signal: agentController.signal,
      onProgress: (message) => { $("#read-progress").textContent = message; },
    });
    agentResultView.reset();
    agentResultView.showResponse(response);
    showReview(false, file.name);
    let fingerprint = file === chosenFile ? chosenFingerprint : null;
    try {
      fingerprint ??= await fileFingerprint(file);
    } catch (error) {
      console.error("도면 구분값 계산 실패:", error instanceof Error ? error.name : typeof error);
    }
    const saved = analysisHistory.save({ fileName: file.name, fingerprint, response });
    $("#agent-result-progress").textContent = saved
      ? "②의 응답을 표시하고 이 브라우저에 저장했어요. 처음으로 돌아가도 다시 열 수 있어요."
      : "②의 응답을 표시했어요. 저장 공간이 부족해 결과를 저장하지 못했어요.";
    renderHistory();
    if (file === chosenFile) checkSavedMatch(file);
  } catch (error) {
    if (error instanceof StudioConnectionError) {
      $("#read-error").textContent = error.message;
    } else if (error instanceof AgentResultError) {
      $("#read-error").textContent = "②의 결과 형식을 읽을 수 없어요. 잠시 후 다시 시도해 주세요.";
    } else {
      console.error("② 분석 결과 표시 실패:", error instanceof Error ? error.name : typeof error);
      $("#read-error").textContent = "②의 결과를 표시하지 못했어요. 잠시 후 다시 시도해 주세요.";
    }
  } finally {
    agentController = null;
    $("#read-progress").textContent = "";
    setBusy(false);
  }
});
cancelAgentButton.addEventListener("click", () => {
  if (!agentController) return;
  cancelAgentButton.disabled = true;
  $("#read-progress").textContent = "기다리기를 중단하는 중이에요…";
  agentController.abort();
});
$("#open-saved-match").addEventListener("click", (event) => openSaved(event.currentTarget.dataset.id));
$("#download-references").addEventListener("click", downloadReferences);
$("#clear-history").addEventListener("click", () => {
  if (busy || !window.confirm("저장된 ② 분석 결과를 모두 삭제할까요? 되돌릴 수 없어요.")) return;
  analysisHistory.clear();
  hideSavedMatch();
  renderHistory();
});
renderHistory();
$("#back-button").addEventListener("click", () => {
  $("#review-screen").hidden = true;
  $("#upload-screen").hidden = false;
  result = null;
  agentResultView.reset();
  list.replaceChildren();
  preview.replaceChildren();
  $("#select-button").focus();
  window.scrollTo({ top: 0 });
});
pageSelect.addEventListener("change", () => {
  offset = 0;
  renderPage();
});
$("#previous-results").addEventListener("click", () => {
  offset = Math.max(0, offset - TABLE_SIZE);
  renderPage();
});
$("#next-results").addEventListener("click", () => {
  offset += TABLE_SIZE;
  renderPage();
});
