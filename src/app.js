import { buildDxfAgentMessage } from "./agent-input.js";
import { readDxf } from "./dxf.js";
import { readPdf } from "./pdf.js";
import { AgentResultError, parseAgentResult } from "./agent-result.js";
import { createAgentResultView } from "./agent-result-view.js";
import {
  analyzeDrawingWithStudio,
  getHostedStudioConfig,
  getHostedStudioToken,
  reviewDrawingWithStudio,
  StudioConnectionError,
} from "./studio-connection.js";
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
const reviewerConsent = $("#reviewer-consent");
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
let hostedMode = false;
let hostedSetupError = false;
let hostedWidgetId = null;
let hostedChallengeResolve = null;
let hostedChallengeReject = null;
let hostedChallengeTimer = null;
let hostedChallengeSignal = null;

const number = (value) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 3 }).format(value);
const point = (value) => `(${number(value.x)}, ${number(value.y)})`;

let progressValue = 0;
let progressTimer = null;
function setProgressPercent(percent) {
  progressValue = Math.max(progressValue, Math.min(100, Math.round(percent)));
  $("#progress-percent").textContent = `${progressValue}%`;
  $("#progress-fill").style.width = `${progressValue}%`;
  $("#progress-track").setAttribute("aria-valuenow", String(progressValue));
}
function startProgress(estimated) {
  clearInterval(progressTimer);
  progressValue = 0;
  setProgressPercent(0);
  $("#progress-box").hidden = false;
  $("#progress-note").hidden = !estimated;
  if (estimated) {
    // 서버 소요 시간을 알 수 없어 90%까지 천천히 다가가게 한다.
    progressTimer = setInterval(() => setProgressPercent(progressValue + (90 - progressValue) * 0.04), 1000);
  }
}
function stopProgress(done) {
  clearInterval(progressTimer);
  if (done) setProgressPercent(100);
  setTimeout(() => { if (!busy) $("#progress-box").hidden = true; }, done ? 600 : 0);
}
function reportProgress(message) {
  $("#progress-label").textContent = message;
  $("#read-progress").textContent = "";
  const pages = /(\d+)\/(\d+)페이지/.exec(message);
  if (pages) return setProgressPercent(((Number(pages[1]) - 0.5) / Number(pages[2])) * 95);
  if (message.includes("보내는")) setProgressPercent(20);
  else if (message.includes("분석하고")) setProgressPercent(30);
  else if (message.includes("연결하는")) setProgressPercent(12);
  else if (message.includes("확인하는")) setProgressPercent(5);
}

function updateAgentStartButton() {
  agentStartButton.disabled = busy
    || !chosenFile
    || !chosenFile.name.toLowerCase().endsWith(".pdf")
    || !reviewerConsent.checked
    || hostedSetupError;
}

function finishHostedChallenge(error, token = null) {
  if (!hostedChallengeResolve) return;
  const resolve = hostedChallengeResolve;
  const reject = hostedChallengeReject;
  hostedChallengeResolve = null;
  hostedChallengeReject = null;
  clearTimeout(hostedChallengeTimer);
  hostedChallengeSignal?.removeEventListener("abort", hostedChallengeAbort);
  hostedChallengeSignal = null;
  if (error) reject(error);
  else resolve(token);
}

function hostedChallengeAbort() {
  finishHostedChallenge(new DOMException("보안 확인이 취소됐어요.", "AbortError"));
}

function requestHostedChallenge(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    hostedChallengeResolve = resolve;
    hostedChallengeReject = reject;
    hostedChallengeSignal = signal;
    signal.addEventListener("abort", hostedChallengeAbort, { once: true });
    hostedChallengeTimer = setTimeout(
      () => finishHostedChallenge(new Error("보안 확인 시간이 초과됐어요. 다시 눌러 주세요.")),
      60_000,
    );
    try {
      window.turnstile.reset(hostedWidgetId);
      window.turnstile.execute(hostedWidgetId);
    } catch (error) {
      finishHostedChallenge(new Error("보안 확인을 시작하지 못했어요."));
    }
  });
}

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = () => window.turnstile ? resolve() : reject(new Error("보안 확인을 시작하지 못했어요."));
    script.onerror = () => reject(new Error("보안 확인 기능을 불러오지 못했어요."));
    document.head.append(script);
  });
}

async function configureHostedConnection() {
  let config;
  try {
    config = await getHostedStudioConfig();
  } catch (error) {
    console.error("자동 연결 설정 확인 실패:", error instanceof Error ? error.name : typeof error);
    hostedSetupError = true;
    $("#read-error").textContent = error.message;
    updateAgentStartButton();
    return;
  }
  if (!config) return;
  hostedMode = true;
  $("#hosted-connection-note").hidden = false;
  $("#turnstile-container").hidden = false;
  updateAgentStartButton();
  try {
    await loadTurnstile();
    hostedWidgetId = window.turnstile.render("#turnstile-container", {
      sitekey: config.siteKey,
      action: "studio-connect",
      size: "invisible",
      appearance: "interaction-only",
      callback: (token) => {
        finishHostedChallenge(null, token);
      },
      "expired-callback": () => {
        finishHostedChallenge(new Error("보안 확인 시간이 지났어요. 다시 눌러 주세요."));
      },
      "error-callback": () => {
        finishHostedChallenge(new Error("자동 연결 보안 확인을 완료하지 못했어요."));
      },
    });
  } catch (error) {
    hostedSetupError = true;
    $("#read-error").textContent = error.message;
    updateAgentStartButton();
  }
}

function setBusy(value, kind = null) {
  busy = value;
  $("#upload-screen").setAttribute("aria-busy", String(value));
  startButton.disabled = value || !chosenFile;
  updateAgentStartButton();
  reviewerConsent.disabled = value;
  $("#select-button").disabled = value;
  $("#agent-result-only").disabled = value;
  fileInput.disabled = value;
  $("#remove-file")?.toggleAttribute("disabled", value);
  startButton.textContent = value && kind === "local" ? "읽는 중…" : "이 브라우저에서만 읽기";
  agentStartButton.textContent = value && kind === "agent" ? "② 분석 중…" : "도면 분석하기";
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
  if (!entry || (!entry.reviewResponse && entry.kind !== "review")) return;
  $("#saved-match-text").textContent =
    `이 도면의 ③ 검토 결과가 ${savedTime(entry.savedAt)}에 저장되어 있어요.`;
  $("#open-saved-match").dataset.id = entry.id;
  $("#open-saved-match").textContent = "저장된 검토 결과 보기";
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
    type.textContent = entry.kind === "review" ? "③" : entry.reviewResponse ? "②+③" : "②";
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
    const buttons = [];
    if (entry.reviewResponse || entry.kind === "review") {
      const openReview = document.createElement("button");
      openReview.className = "select-button review-result-button";
      openReview.type = "button";
      openReview.textContent = "검토 결과 보기";
      openReview.setAttribute("aria-label", `${entry.fileName} 저장된 ③ 검토 결과 보기`);
      openReview.disabled = busy;
      openReview.addEventListener("click", () => openSaved(entry.id, "review"));
      buttons.push(openReview);
    }
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
    item.append(type, info, verifyLabel, ...buttons, remove);
    return item;
  }));
}

function openSaved(id, resultType = "analysis") {
  if (busy) return;
  const entry = analysisHistory.get(id);
  $("#read-error").textContent = "";
  if (!entry) {
    $("#read-error").textContent = "저장된 결과를 찾지 못했어요. 이미 삭제됐을 수 있어요.";
    hideSavedMatch();
    renderHistory();
    return;
  }
  const response = resultType === "review"
    ? entry.kind === "review" ? entry.response : entry.reviewResponse
    : entry.response;
  if (!response) {
    $("#read-error").textContent = "저장된 ③ 검토 결과가 없어요.";
    return;
  }
  const analysisResponse = resultType === "review" && entry.kind !== "review" ? entry.response : null;
  try {
    agentResultView.reset();
    agentResultView.showResponse(response, analysisResponse);
  } catch (error) {
    agentResultView.reset();
    if (resultType === "analysis") {
      analysisHistory.remove(entry.id);
      renderHistory();
      hideSavedMatch();
      $("#read-error").textContent = "저장된 ② 결과를 읽을 수 없어 목록에서 지웠어요. 도면을 다시 분석해 주세요.";
    } else {
      $("#read-error").textContent = "저장된 ③ 검토 결과를 읽을 수 없어요. ② 결과는 보관되어 있어요.";
    }
    console.error("저장된 결과 열기 실패:", error instanceof Error ? error.name : typeof error);
    return;
  }
  showReview(false, entry.fileName);
  $("#agent-result-progress").textContent =
    `${savedTime(entry.savedAt)}에 이 브라우저에 저장된 ${resultType === "review" ? "③ 검토" : "② 분석"} 결과예요. 다시 분석하지 않고 전송하지도 않고 바로 열었어요.`;
}

function showFile(file) {
  if (busy) return;
  $("#read-error").textContent = "";
  $("#read-progress").textContent = "";
  reviewerConsent.checked = false;
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
  updateAgentStartButton();
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
    reviewerConsent.checked = false;
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
  renderAgentInput();
  offset = 0;
  renderPage();
}

function renderAgentInput() {
  const isDxf = result?.format === "DXF";
  $("#agent-input-card").hidden = !isDxf;
  $("#agent-input-status").textContent = "";
  const text = isDxf ? buildDxfAgentMessage(result, chosenFile.name) : "";
  $("#agent-input-text").value = text;
  $("#agent-input-count").textContent = isDxf ? `${number(Array.from(text).length)}자 · 잘리지 않게 전체를 붙여넣으세요.` : "";
}

function showReview(hasDrawing, agentFileName = null) {
  $(".reading-results").hidden = !hasDrawing;
  $(".review-layout").hidden = !hasDrawing;
  $("#result-title").textContent = hasDrawing ? "도면 읽기 결과" : $("#agent-result-title").textContent;
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
  renderFeedback(elements, flip, Math.max(width, height));
}

const MAX_FEEDBACK = 20;

function flagReason(element) {
  const name = { line: "선", circle: "원", text: "글자" }[element.kind];
  if (element.source === "ocr") {
    return [`글자 “${element.text}”를 확인해 주세요`, `사진 속 글자를 글자 인식(OCR)으로 추정했어요(신뢰도 ${Math.round(element.confidence)}%). 원본 도면의 글자와 같은지 비교해 주세요.`];
  }
  if (element.source === "image") {
    return [`${name} 후보를 확인해 주세요`, `이미지에서 찾은 ${name}이라 실제 도면과 다를 수 있어요. 원본에 같은 ${name}이 있는지 확인해 주세요.`];
  }
  return [`${name}의 위치·내용을 확인해 주세요`, `읽은 값이 불확실해요. 원본 도면과 비교해 맞는지 확인해 주세요.`];
}

function markerPosition(element, flip) {
  if (element.kind === "line") {
    return { x: (element.start.x + element.end.x) / 2, y: flip * (element.start.y + element.end.y) / 2 };
  }
  if (element.kind === "circle") return { x: element.center.x, y: flip * element.center.y };
  return { x: element.position.x, y: flip * element.position.y };
}

function renderFeedback(elements, flip, extent) {
  const flagged = elements.filter((element) => element.uncertain || element.source === "ocr" || element.source === "image");
  const shown = flagged.slice(0, MAX_FEEDBACK);
  const radius = extent * 0.014;
  const svgNs = "http://www.w3.org/2000/svg";
  const items = shown.map((element, index) => {
    const { x, y } = markerPosition(element, flip);
    const marker = document.createElementNS(svgNs, "g");
    marker.setAttribute("class", "marker");
    const dot = document.createElementNS(svgNs, "circle");
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", radius);
    const label = document.createElementNS(svgNs, "text");
    label.setAttribute("x", x);
    label.setAttribute("y", y);
    label.setAttribute("font-size", radius * 1.2);
    label.textContent = String(index + 1);
    marker.append(dot, label);
    preview.append(marker);

    const [title, detail] = flagReason(element);
    const item = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = String(index + 1);
    const body = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = title;
    const paragraph = document.createElement("p");
    paragraph.textContent = detail;
    body.append(strong, paragraph);
    item.append(badge, body);
    const activate = () => {
      $("#feedback-list").querySelectorAll("li.active").forEach((node) => node.classList.remove("active"));
      preview.querySelectorAll(".marker.active").forEach((node) => node.classList.remove("active"));
      item.classList.add("active");
      marker.classList.add("active");
    };
    item.addEventListener("click", activate);
    marker.addEventListener("click", () => { activate(); item.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
    marker.style.cursor = "pointer";
    return item;
  });
  $("#feedback-list").replaceChildren(...items);
  $("#feedback-notes").replaceChildren(...result.warnings.map((message) => {
    const note = document.createElement("li");
    note.textContent = message;
    return note;
  }));
  $("#feedback-empty").hidden = Boolean(items.length || result.warnings.length);
  $("#feedback-more").textContent = flagged.length > shown.length
    ? `이 페이지에는 확인이 필요한 곳이 ${flagged.length}개 더 있어요. 앞의 ${shown.length}개만 표시해요. 전체는 ‘읽어낸 선·원·글자 자세히 보기’의 표에서 확인하세요.`
    : "";
}

$("#select-button").addEventListener("click", () => fileInput.click());
reviewerConsent.addEventListener("change", () => {
  updateAgentStartButton();
});
$("#agent-result-only").addEventListener("click", () => {
  if (!busy) {
    agentResultView.openManual();
    showReview(false);
  }
});
$("#agent-result-save").addEventListener("click", () => {
  const input = $("#agent-result-input");
  try {
    const parsed = parseAgentResult(input.value);
    const isReview = parsed.data.schema_version === "2.0";
    const entry = analysisHistory.save({
      fileName: isReview ? "직접 입력한 ③ 검토 결과" : "직접 입력한 ② 분석 결과",
      fingerprint: null,
      response: input.value,
      kind: isReview ? "review" : "analysis",
    });
    if (!entry) {
      $("#agent-result-progress").textContent = "저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.";
      return;
    }
    renderHistory();
    $("#agent-result-progress").textContent = "이 결과를 이 브라우저에 저장했어요. 처음 화면의 저장 목록에서 다시 열 수 있어요.";
    $("#agent-result-save").disabled = true;
  } catch (error) {
    $("#agent-result-progress").textContent =
      error instanceof AgentResultError ? error.message : "결과를 저장하지 못했어요. 다시 시도해 주세요.";
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
  startProgress(false);
  reportProgress("파일 읽는 중…");
  result = null;
  list.replaceChildren();
  preview.replaceChildren();
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const buffer = await chosenFile.arrayBuffer();
    if (!buffer.byteLength) throw new Error("빈 파일이에요. 내용이 있는 DXF 또는 PDF를 선택해 주세요.");
    result = chosenFile.name.toLowerCase().endsWith(".dxf")
      ? readDxf(buffer)
      : await readPdf(buffer, reportProgress);
    renderResult();
    showReview(true);
    stopProgress(true);
  } catch (error) {
    stopProgress(false);
    result = null;
    console.error("도면 읽기 실패:", error);
    $("#read-error").textContent = `읽지 못했어요. ${error.message}`;
  } finally {
    $("#read-progress").textContent = "";
    setBusy(false);
  }
});
agentStartButton.addEventListener("click", async () => {
  if (!chosenFile || !chosenFile.name.toLowerCase().endsWith(".pdf") || !reviewerConsent.checked || busy) return;
  const file = chosenFile;
  let analysisResponse = null;
  agentController = new AbortController();
  setBusy(true, "agent");
  $("#read-error").textContent = "";
  startProgress(true);
  try {
    let hostedTokens = null;
    if (hostedMode) {
      $("#read-progress").textContent = "② 연결 보안 확인 중이에요…";
      const challenge = await requestHostedChallenge(agentController.signal);
      hostedTokens = await getHostedStudioToken("analysis", challenge, { signal: agentController.signal });
    }
    analysisResponse = await analyzeDrawingWithStudio(file, {
      hostedAccess: hostedTokens,
      signal: agentController.signal,
      onProgress: reportProgress,
    });
    let fingerprint = file === chosenFile ? chosenFingerprint : null;
    try {
      fingerprint ??= await fileFingerprint(file);
    } catch (error) {
      console.error("도면 구분값 계산 실패:", error instanceof Error ? error.name : typeof error);
    }
    const saved = analysisHistory.save({ fileName: file.name, fingerprint, response: analysisResponse });
    if (saved) {
      renderHistory();
      await checkSavedMatch(file);
    }
    if (hostedMode) {
      $("#read-progress").textContent = "③ 연결 보안 확인 중이에요…";
      const challenge = await requestHostedChallenge(agentController.signal);
      hostedTokens = await getHostedStudioToken("reviewer", challenge, { signal: agentController.signal });
    }
    const reviewResponse = await reviewDrawingWithStudio(file, {
      analysisResult: analysisResponse,
      hostedAccess: hostedTokens,
      signal: agentController.signal,
      onProgress: reportProgress,
    });
    stopProgress(true);
    agentResultView.reset();
    agentResultView.showResponse(reviewResponse, analysisResponse);
    const reviewSaved = saved && analysisHistory.saveReview(saved.id, reviewResponse);
    if (reviewSaved) {
      renderHistory();
      if (file === chosenFile) await checkSavedMatch(file);
    }
    showReview(false, file.name);
    $("#agent-result-progress").textContent =
      `검토를 마쳤어요.${saved && reviewSaved
        ? " 결과를 이 브라우저에 저장했어요."
        : saved
          ? " 결과를 저장하지 못했어요."
          : " 결과를 브라우저에 저장하지 못했어요."} 원본 도면과 직접 비교해 주세요.`;
  } catch (error) {
    stopProgress(false);
    if (analysisResponse != null) {
      agentResultView.reset();
      showReview(false, file.name);
      $("#agent-result-progress").textContent = "② 분석은 끝났지만 ③ 검토는 완료되지 않았어요. ②의 분석 내용은 화면에 표시하지 않아요.";
      $("#read-error").textContent = error instanceof StudioConnectionError
        ? `③ 검토를 완료하지 못했어요. ${error.message}`
        : error instanceof AgentResultError
          ? "③ 검토 응답을 읽지 못했어요. 다시 시도해 주세요."
          : hostedMode && error instanceof Error
            ? `③ 검토 연결 확인을 완료하지 못했어요. ${error.message}`
          : "③ 검토 결과를 표시하지 못했어요. 다시 시도해 주세요.";
    } else if (error instanceof StudioConnectionError) {
      $("#read-error").textContent = error.message;
    } else if (hostedMode && error instanceof Error) {
      $("#read-error").textContent = error.message;
    } else if (error instanceof AgentResultError) {
      $("#read-error").textContent = "②의 결과 형식을 읽을 수 없어요. 잠시 후 다시 시도해 주세요.";
    } else {
      console.error("② 분석 결과 표시 실패:", error instanceof Error ? error.name : typeof error);
      $("#read-error").textContent = "②의 결과를 표시하지 못했어요. 잠시 후 다시 시도해 주세요.";
    }
  } finally {
    agentController = null;
    reviewerConsent.checked = false;
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
$("#open-saved-match").addEventListener("click", (event) => openSaved(event.currentTarget.dataset.id, "review"));
$("#download-references").addEventListener("click", downloadReferences);
$("#clear-history").addEventListener("click", () => {
  if (busy || !window.confirm("저장된 분석·검토 결과를 모두 삭제할까요? 되돌릴 수 없어요.")) return;
  analysisHistory.clear();
  hideSavedMatch();
  renderHistory();
});
renderHistory();
await configureHostedConnection();
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add("visible");
    revealObserver.unobserve(entry.target);
  });
}, { threshold: 0.15 });
document.querySelectorAll(".intro-section, .intro-bottom").forEach((el) => {
  el.classList.add("reveal");
  revealObserver.observe(el);
});
function showIntro() {
  if (busy) return;
  $("#review-screen").hidden = true;
  $("#upload-screen").hidden = true;
  $("#intro-screen").hidden = false;
  window.scrollTo({ top: 0 });
}
function showUpload() {
  $("#intro-screen").hidden = true;
  $("#upload-screen").hidden = false;
  window.scrollTo({ top: 0 });
}
$("#brand-home").addEventListener("click", showIntro);
$("#start-intro").addEventListener("click", showUpload);
$("#start-intro-bottom").addEventListener("click", showUpload);
$("#back-button").addEventListener("click", () => {
  $("#review-screen").hidden = true;
  $("#upload-screen").hidden = false;
  result = null;
  agentResultView.reset();
  list.replaceChildren();
  preview.replaceChildren();
  renderAgentInput();
  $("#select-button").focus();
  window.scrollTo({ top: 0 });
});
$("#copy-agent-input").addEventListener("click", async () => {
  const textarea = $("#agent-input-text");
  const text = textarea.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (textarea.value !== text) return;
    $("#agent-input-status").textContent = "복사했어요. Copilot Studio의 ③ 도면 검토 에이전트 새 대화에 붙여넣으세요.";
  } catch {
    if (textarea.value !== text) return;
    textarea.focus();
    textarea.select();
    $("#agent-input-status").textContent = "자동 복사가 막혀 있어요. 선택된 내용을 Ctrl+C로 직접 복사해 주세요.";
  }
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
