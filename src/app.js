import { readDxf } from "./dxf.js";
import { readPdf } from "./pdf.js";
import { coordinateNote, serializeReaderResult } from "./reader-export.js";

const $ = (selector) => document.querySelector(selector);
const fileInput = $("#file-input");
const startButton = $("#start-button");
const dropArea = $("#drop-area");
const pageSelect = $("#page-select");
const list = $("#element-list");
const preview = $("#drawing-preview");
const copyButton = $("#copy-result");
const copyData = $("#copy-data");
const sensitiveCheck = $("#sensitive-check");
const openChatButton = $("#open-chat");
const TABLE_SIZE = 100;
const CHAT_URL = "https://copilotstudio.microsoft.com/environments/Default-62ae463a-9f12-4edf-8544-4f6ca3834524/bots/cre4a_bot_GA1WSN/webchat?__version__=2&enableFileAttachment=false&cliAgent=true";
let chosenFile = null;
let busy = false;
let result = null;
let offset = 0;
let copiedResult = null;
let copyRequest = 0;

const number = (value) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 3 }).format(value);
const point = (value) => `(${number(value.x)}, ${number(value.y)})`;

function closeChat() {
  $("#chat-frame").replaceChildren();
  $("#chat-panel").hidden = true;
  $("#chat-status").textContent = "";
  $("#chat-external-link").removeAttribute("href");
  openChatButton.textContent = "3. 채팅 열기";
  openChatButton.setAttribute("aria-expanded", "false");
}

function clearResult() {
  result = null;
  copiedResult = null;
  copyRequest += 1;
  list.replaceChildren();
  preview.replaceChildren();
  pageSelect.replaceChildren();
  $("#reading-warnings").replaceChildren();
  $("#selected-file-name").textContent = "";
  $("#reading-summary").textContent = "";
  $("#coordinate-note").textContent = "";
  $("#page-summary").textContent = "";
  $("#result-range").textContent = "";
  $("#previous-results").disabled = true;
  $("#next-results").disabled = true;
  copyData.value = "";
  sensitiveCheck.checked = false;
  sensitiveCheck.disabled = false;
  copyButton.disabled = true;
  copyButton.textContent = "2. 전체 결과 복사";
  $("#select-copy-data").disabled = true;
  $("#confirm-manual-copy").disabled = true;
  openChatButton.disabled = true;
  $("#copy-preview").open = false;
  $("#copy-status").textContent = "";
  $("#copy-error").textContent = "";
  closeChat();
}

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
  clearResult();
  $("#review-screen").hidden = true;
  $("#upload-screen").hidden = false;
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
    clearResult();
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
  $("#selected-file-name").textContent = `선택한 도면: ${chosenFile.name}`;
  $("#reading-summary").textContent = `${result.format} 읽기 결과 · ${summary(result.elements)} · 도면의 정확성을 판단한 결과는 아니에요.`;
  $("#coordinate-note").textContent = coordinateNote(result);
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
  copyData.value = serializeReaderResult(result);
  $("#select-copy-data").disabled = false;
  offset = 0;
  renderPage();
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
    clearResult();
    chosenFile = null;
    fileInput.value = "";
    renderFile();
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
  clearResult();
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
    clearResult();
    $("#review-screen").hidden = true;
    $("#upload-screen").hidden = false;
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
  clearResult();
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

sensitiveCheck.addEventListener("change", () => {
  copyButton.disabled = !result || !sensitiveCheck.checked;
  $("#confirm-manual-copy").disabled = !result || !sensitiveCheck.checked;
  if (!sensitiveCheck.checked) {
    copiedResult = null;
    openChatButton.disabled = true;
    $("#copy-status").textContent = "";
    closeChat();
  }
});

function markCopied(manual = false) {
  copiedResult = result;
  openChatButton.disabled = false;
  $("#copy-status").textContent = manual
    ? "직접 복사를 마쳤다고 확인했어요. 채팅을 열고 직접 붙여넣은 뒤 전송하세요."
    : `전체 ${result.pages.length}페이지의 읽기 결과를 복사했어요. 아직 외부로 전송하지 않았어요. 채팅을 열고 직접 붙여넣은 뒤 전송하세요.`;
}

$("#select-copy-data").addEventListener("click", () => {
  if (!result) return;
  copyData.focus();
  copyData.select();
});
$("#confirm-manual-copy").addEventListener("click", () => {
  if (!result || !sensitiveCheck.checked || sensitiveCheck.disabled) return;
  markCopied(true);
});
copyButton.addEventListener("click", async () => {
  if (!result || !sensitiveCheck.checked || sensitiveCheck.disabled) return;
  const request = ++copyRequest;
  const text = serializeReaderResult(result);
  copiedResult = null;
  openChatButton.disabled = true;
  copyButton.disabled = true;
  copyButton.textContent = "복사 중…";
  sensitiveCheck.disabled = true;
  $("#confirm-manual-copy").disabled = true;
  $("#copy-error").textContent = "";
  $("#copy-status").textContent = "";
  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error("이 브라우저나 접속 주소에서는 자동 복사를 지원하지 않아요.");
    }
    await navigator.clipboard.writeText(text);
    if (request !== copyRequest) return;
    markCopied();
  } catch (error) {
    if (request !== copyRequest) return;
    console.error("도면 결과 복사 실패:", error);
    $("#copy-error").textContent = `복사하지 못했어요. ${error.message} 아래 전체 결과에서 직접 복사해 주세요.`;
    $("#copy-preview").open = true;
    copyData.focus();
    copyData.select();
  } finally {
    if (request === copyRequest) {
      sensitiveCheck.disabled = false;
      copyButton.disabled = !sensitiveCheck.checked;
      copyButton.textContent = "2. 전체 결과 복사";
      $("#confirm-manual-copy").disabled = !sensitiveCheck.checked;
    }
  }
});

openChatButton.addEventListener("click", () => {
  if (!result || copiedResult !== result || !sensitiveCheck.checked) return;
  if (!$("#chat-frame").firstElementChild) {
    const frame = document.createElement("iframe");
    frame.title = "Microsoft Copilot Studio 도면 분석 에이전트 채팅";
    frame.referrerPolicy = "no-referrer";
    frame.addEventListener("load", () => {
      if (!frame.isConnected) return;
      $("#chat-status").textContent = "채팅 입력창이 보이는지 확인하세요. 표시되지 않거나 로그인 요청이 나오면 새 탭으로 열거나 관리자에게 알려 주세요.";
    });
    frame.addEventListener("error", () => {
      if (!frame.isConnected) return;
      console.error("Copilot Studio 채팅 화면을 불러오지 못했어요.");
      $("#chat-status").textContent = "채팅 화면을 불러오지 못했어요. 새 탭으로 열거나 관리자에게 알려 주세요.";
    });
    frame.src = CHAT_URL;
    $("#chat-frame").append(frame);
    $("#chat-external-link").href = CHAT_URL;
    $("#chat-status").textContent = "Microsoft에 접속 중이에요. 채팅이 보이면 복사한 JSON을 직접 붙여넣고 전송하세요.";
  }
  $("#chat-panel").hidden = false;
  openChatButton.setAttribute("aria-expanded", "true");
  openChatButton.textContent = "열린 채팅으로 이동";
  $("#chat-title").focus();
  $("#chat-panel").scrollIntoView({ block: "start", behavior: "smooth" });
});
$("#close-chat").addEventListener("click", () => {
  closeChat();
  openChatButton.focus();
});
