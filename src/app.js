import { readDxf } from "./dxf.js";
import { readPdf } from "./pdf.js";
import { reviewFitNotation } from "./fit-review.js";

const $ = (selector) => document.querySelector(selector);
const fileInput = $("#file-input");
const startButton = $("#start-button");
const dropArea = $("#drop-area");
const pageSelect = $("#page-select");
const list = $("#element-list");
const preview = $("#drawing-preview");
const TABLE_SIZE = 100;
let chosenFile = null;
let busy = false;
let result = null;
let offset = 0;

const number = (value) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 3 }).format(value);
const point = (value) => `(${number(value.x)}, ${number(value.y)})`;

function setBusy(value) {
  busy = value;
  $("#upload-screen").setAttribute("aria-busy", String(value));
  startButton.disabled = value || !chosenFile;
  $("#select-button").disabled = value;
  fileInput.disabled = value;
  $("#remove-file")?.toggleAttribute("disabled", value);
  startButton.textContent = value ? "읽는 중…" : "도면 읽기";
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
}

function renderFile() {
  const container = $("#file-list");
  container.replaceChildren();
  startButton.disabled = busy || !chosenFile;
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
  renderFitReview();
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

function renderFitReview() {
  const review = reviewFitNotation(result);
  $("#fit-state").textContent = review.state;
  $("#fit-reason").textContent = review.reason;
  $("#fit-scope").textContent = `전체 ${result.pages.length}개 페이지·공간의 글자 ${review.checkedTexts}개를 확인했어요.`;
  $("#fit-limit").textContent = review.limit;
  $("#fit-warnings").replaceChildren(...review.reasons.map((reason) => {
    const item = document.createElement("li");
    item.textContent = reason;
    return item;
  }));
  $("#fit-candidates").replaceChildren(...review.candidates.map((candidate) => {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = `${candidate.notation} · ${candidate.uncertain ? "읽기 불확실·원본 확인 필요" : "문제 후보"}`;
    item.append(title);
    for (const element of candidate.evidence) {
      const evidence = document.createElement("p");
      const location = result.format === "PDF" ? `${element.page}페이지` : "DXF 모형 공간";
      const confidence = element.source === "ocr" ? ` · OCR ${number(element.confidence)}%` : " · 파일에서 읽음";
      evidence.textContent = `근거 ‘${element.text}’ · ${location} · 기준점 ${point(element.position)} · ${result.unit}${confidence}`;
      item.append(evidence);
    }
    return item;
  }));
}

function clearFitReview() {
  for (const id of ["fit-state", "fit-reason", "fit-scope", "fit-limit", "fit-warnings", "fit-candidates"]) {
    $(`#${id}`).replaceChildren();
  }
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
  setBusy(true);
  $("#read-error").textContent = "";
  $("#read-progress").textContent = "파일 읽는 중…";
  result = null;
  clearFitReview();
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
    $("#upload-screen").hidden = true;
    $("#review-screen").hidden = false;
    $("#result-title").focus();
    window.scrollTo({ top: 0 });
  } catch (error) {
    result = null;
    clearFitReview();
    console.error("도면 읽기 실패:", error);
    $("#read-error").textContent = `읽지 못했어요. ${error.message}`;
  } finally {
    $("#read-progress").textContent = "";
    setBusy(false);
  }
});
$("#back-button").addEventListener("click", () => {
  $("#review-screen").hidden = true;
  $("#upload-screen").hidden = false;
  result = null;
  clearFitReview();
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
