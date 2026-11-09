import { readDxf } from "../src/dxf.js";
import { readPdf } from "../src/pdf.js";
import { inferCircle, multiply, transform } from "../src/geometry.js";
import { detectScanGeometry, pageScaleForScan } from "../src/scan.js";
import { serializeReaderResult } from "../src/reader-export.js";

window.testResults = { done: false, passed: 0, failed: 0, failures: [] };
const tests = [];
const test = (name, action) => tests.push({ name, action });
const assert = (condition, message = "기대 결과와 달라요.") => { if (!condition) throw new Error(message); };
const near = (actual, expected, tolerance = 0.01) => assert(Math.abs(actual - expected) < tolerance, `${actual} ≠ ${expected}`);
const encode = (text) => new TextEncoder().encode(text).buffer;
async function fixture(name) {
  const response = await fetch(`./fixtures/${name}?test=${Date.now()}`, { cache: "no-store" });
  assert(response.ok, `예제 ${name}을 불러오지 못했어요.`);
  return response.arrayBuffer();
}
async function fixtureText(name) {
  return new TextDecoder().decode(await fixture(name)).replace(/\r\n?/g, "\n");
}
async function rejects(action, message) {
  let caught;
  try { await action(); } catch (error) { caught = error; }
  assert(caught && caught.message.includes(message), `오류에 '${message}'가 필요해요. 실제: ${caught?.message ?? "오류 없음"}`);
}
function dxfEntities(content) {
  return encode(`0\nSECTION\n2\nENTITIES\n${content}0\nENDSEC\n0\nEOF\n`);
}

test("DXF 예제: 선·원·한글의 개수와 정확한 좌표", async () => {
  const result = readDxf(await fixture("simple.dxf"));
  assert(result.elements.length === 3);
  assert(result.unit === "mm" && result.warnings.length === 0);
  const [line, circle, text] = result.elements;
  assert(line.kind === "line" && circle.kind === "circle" && text.kind === "text");
  near(line.start.x, 20); near(line.start.y, 30); near(line.end.x, 140); near(line.end.y, 30);
  near(circle.center.x, 200); near(circle.center.y, 130); near(circle.radius, 25);
  assert(text.text === "도면 예제"); near(text.position.x, 20); near(text.position.y, 190);
});
test("DXF 줄바꿈·BOM·대문자 확장자와 무관한 내용 읽기", async () => {
  const text = await fixtureText("simple.dxf");
  assert(readDxf(encode(`\uFEFF${text.replace(/\n/g, "\r\n")}`)).elements.length === 3);
});
test("DXF 연결선의 직선 구간과 닫힘", () => {
  const result = readDxf(dxfEntities("0\nLWPOLYLINE\n90\n3\n70\n1\n10\n0\n20\n0\n10\n10\n20\n0\n10\n10\n20\n10\n"));
  assert(result.elements.length === 3);
  near(result.elements[2].end.x, 0);
});
test("DXF 원호 구간과 미지원 요소를 숨기지 않고 안내", () => {
  const result = readDxf(dxfEntities("0\nLWPOLYLINE\n90\n3\n10\n0\n20\n0\n42\n1\n10\n10\n20\n0\n10\n10\n20\n10\n0\nINSERT\n2\nBLOCK\n"));
  assert(result.elements.length === 1);
  assert(result.warnings.some((warning) => warning.includes("원호")));
  assert(result.warnings.some((warning) => warning.includes("INSERT")));
});
test("DXF 다중 행 글자와 유니코드 이스케이프", () => {
  const result = readDxf(dxfEntities("0\nMTEXT\n10\n1\n20\n2\n40\n3\n3\n\\U+B3C4\n1\n\\U+BA74\\Ptest\n"));
  assert(result.elements[0].text === "도면\ntest");
  assert(result.warnings.length > 0);
});
test("DXF 일반 글자의 중괄호·경로 보존과 빈 글자 제외", async () => {
  const text = "{A} C:\\Parts";
  const result = readDxf(dxfEntities(`0\nTEXT\n10\n1\n20\n2\n40\n3\n1\n${text}\n`));
  assert(result.elements[0].text === text);
  await rejects(() => readDxf(dxfEntities("0\nTEXT\n10\n1\n20\n2\n40\n3\n1\n\n")), "내용 없는");
});
test("빈 DXF·잘린 DXF·숫자 손상은 성공하지 않음", async () => {
  await rejects(() => readDxf(encode("")), "짝");
  const text = await fixtureText("simple.dxf");
  await rejects(() => readDxf(encode(text.replace("EOF", ""))), "짝");
  await rejects(() => readDxf(encode(text.replace("40\n25", "40\nNaN"))), "숫자");
  await rejects(() => readDxf(encode(text.replace("40\n25", "40\n-1"))), "반지름");
});
test("DXF 바이너리·3D·미지원 전용 파일은 성공하지 않음", async () => {
  await rejects(() => readDxf(encode("AutoCAD Binary DXF\r\n")), "바이너리");
  await rejects(() => readDxf(dxfEntities("0\nINSERT\n2\nBLOCK\n")), "읽을 수 있는");
  await rejects(() => readDxf(dxfEntities("0\nLINE\n10\n0\n20\n0\n30\n2\n11\n1\n21\n1\n")), "3차원");
});
test("행렬 곱으로 이동·확대 좌표를 정확히 계산", () => {
  const point = transform(multiply([2, 0, 0, 2, 30, 40], [1, 0, 0, 1, 5, 7]), 10, 10);
  near(point.x, 60); near(point.y, 74);
  assert(inferCircle([]) === null);
});
test("일반 PDF: 첫 페이지의 선·원·글자와 위치", async () => {
  const result = await readPdf(await fixture("simple.pdf"));
  assert(result.pages.length === 2);
  const items = result.elements.filter((element) => element.page === 1);
  assert(items.length === 3, `첫 페이지 요소 개수: ${items.length}`);
  const line = items.find((element) => element.kind === "line");
  near(line.start.x, 20); near(line.start.y, 210); near(line.end.x, 140); near(line.end.y, 210);
  const circle = items.find((element) => element.kind === "circle");
  assert(circle, "PDF 원을 찾지 못했어요.");
  near(circle.center.x, 200); near(circle.center.y, 110); near(circle.radius, 25);
  assert(circle.uncertain, "PDF 원은 추정 결과여야 해요.");
  const text = items.find((element) => element.kind === "text");
  assert(text.text === "Hello blueprint");
  near(text.position.x, 20); near(text.position.y, 50);
  assert(result.warnings.some((warning) => warning.includes("원은 곡선")));
});
test("PDF 두 번째 페이지: 회전·잘라낸 페이지·중첩 도형의 좌표, 타원 제외", async () => {
  const result = await readPdf(await fixture("simple.pdf"));
  const items = result.elements.filter((element) => element.page === 2);
  assert(items.length === 3, `두 번째 페이지 요소 개수: ${items.length}`);
  const lines = items.filter((element) => element.kind === "line");
  assert(lines.length === 2);
  near(lines[0].start.x, 40); near(lines[0].start.y, 30);
  near(lines[0].end.x, 40); near(lines[0].end.y, 50);
  near(lines[1].start.x, 54); near(lines[1].start.y, 50);
  near(lines[1].end.x, 54); near(lines[1].end.y, 70);
  assert(!items.some((element) => element.kind === "circle"), "타원을 원으로 오인했어요.");
  assert(result.warnings.some((warning) => warning.includes("곡선은 제외")));
});
test("이미지뿐인 빈 PDF는 읽지 못한 요소를 확인 필요로 안내하고 성공하지 않음", async () => {
  await rejects(async () => readPdf(await fixture("scan-only.pdf")), "글자를 찾지 못했어요");
});
test("일반·스캔 혼합 PDF에서 빈 결과 페이지도 유지하고 경고", async () => {
  const result = await readPdf(await fixture("mixed.pdf"));
  assert(result.pages.length === 2);
  assert(result.elements.some((element) => element.page === 1));
  assert(result.elements.some((element) => element.page === 2 && element.source === "ocr"));
  assert(result.warnings.some((warning) => warning.includes("2페이지 확인 필요")));
  const copied = JSON.parse(serializeReaderResult(result));
  for (const key of ["pages", "elements", "warnings"]) {
    assert(JSON.stringify(copied[key]) === JSON.stringify(result[key]), `${key}를 그대로 보존해야 해요.`);
  }
});
test("스캔 PDF: 이미지 글자 OCR, 선·원 위치, 불확실성 표시", async () => {
  const result = await readPdf(await fixture("scan.pdf"));
  assert(result.pages.length === 1);
  const texts = result.elements.filter((element) => element.kind === "text");
  assert(texts.some((element) => element.source === "ocr" && /5/.test(element.text)),
    `OCR이 숫자 '5'를 읽지 못했어요: ${texts.map((element) => element.text).join(", ")}`);
  assert(texts.every((element) => element.uncertain || element.confidence >= 80));
  const line = result.elements.find((element) => element.kind === "line");
  assert(line, "스캔한 직선을 찾지 못했어요.");
  near(line.start.y, 70, 3); near(line.end.y, 70, 3);
  const circle = result.elements.find((element) => element.kind === "circle");
  assert(circle, "스캔한 원을 찾지 못했어요.");
  near(circle.center.x, 230, 4); near(circle.center.y, 120, 4); near(circle.radius, 27.5, 4);
  assert(circle.uncertain && line.uncertain);
});
test("스캔 이미지 크기는 메모리 한도 안에서 3배 이하로 처리", () => {
  const scale = pageScaleForScan(595, 842);
  assert(scale <= 3 && 595 * scale * 842 * scale <= 5_000_000);
  assert(pageScaleForScan(10000, 20000) < 1);
});
test("이미지에서 긴 선과 둥근 원을 찾고 모두 확인 필요로 표시", () => {
  const width = 220;
  const height = 170;
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  function pixel(x, y) {
    const offset = (y * width + x) * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = 0;
    data[offset + 3] = 255;
  }
  for (let x = 20; x <= 190; x += 1) {
    pixel(x, 25);
    pixel(x, 26);
  }
  for (let index = 0; index < 360; index += 1) {
    const angle = index * Math.PI / 180;
    pixel(Math.round(130 + Math.cos(angle) * 30), Math.round(100 + Math.sin(angle) * 30));
  }
  const elements = detectScanGeometry({ width, height, data });
  const line = elements.find((element) => element.kind === "line");
  const circle = elements.find((element) => element.kind === "circle");
  assert(line, "가로 선을 찾지 못했어요.");
  near(line.start.y, 25, 2);
  assert(circle, "원을 찾지 못했어요.");
  near(circle.center.x, 130, 3); near(circle.center.y, 100, 3); near(circle.radius, 30, 4);
  assert(elements.every((element) => element.uncertain));
});
test("PDF 사각형·채움 도형의 닫는 변을 읽고 그리지 않은 경로 제외", async () => {
  const result = await readPdf(await fixture("paths.pdf"));
  assert(result.elements.length === 7, `네 변 사각형 + 세 변 삼각형: ${result.elements.length}`);
  assert(result.elements.every((element) => element.kind === "line"));
  const closing = result.elements.at(-1);
  near(closing.start.x, 120); near(closing.start.y, 120);
  near(closing.end.x, 100); near(closing.end.y, 140);
});
test("이름만 PDF인 손상 파일은 쉬운 오류 안내", async () => {
  await rejects(async () => readPdf(await fixture("broken.pdf")), "손상");
});

test("복사 계약: DXF 원본 단위·좌표를 보존하고 파일명은 제외", async () => {
  const result = readDxf(await fixture("simple.dxf"));
  result.file_name = "비공개-고객명.dxf";
  const text = serializeReaderResult(result);
  const copied = JSON.parse(text);
  assert(copied.schema_version === "homepage-reader-v1");
  assert(copied.format === "DXF" && copied.unit === result.unit);
  assert(!text.includes(result.file_name) && !Object.hasOwn(copied, "file_name"));
  for (const key of ["pages", "elements", "warnings"]) {
    assert(JSON.stringify(copied[key]) === JSON.stringify(result[key]));
  }
  assert(copied.coordinate_note.includes("원본 값 그대로"));
  assert(copied.reading_note.includes("설계 적합성 판정이 아니"));
  const original = { ...result, unit: "인치", elements: [{ kind: "line", start: { x: -0.1234567, y: 1.2345678 }, end: { x: 9.8765432, y: 2.3456789 } }] };
  const unchanged = JSON.parse(serializeReaderResult(original));
  assert(unchanged.unit === original.unit && JSON.stringify(unchanged.elements) === JSON.stringify(original.elements));
});
test("복사 계약: 빈 페이지·미지원 경고·OCR 신뢰도와 uncertain을 변환하지 않음", () => {
  const result = {
    format: "PDF", unit: "포인트(1/72인치)",
    pages: [{ number: 1, width: 300, height: 200 }, { number: 2, width: 200, height: 300 }, { number: 3, width: 300, height: 200 }],
    elements: [
      { kind: "text", page: 1, text: "치수 후보 5", source: "ocr", confidence: 57.12345, uncertain: true, position: { x: 2.34567, y: 8.76543 }, scanBox: { x0: 7, y0: 26, x1: 19, y1: 42 } },
      { kind: "line", page: 2, source: "image", confidence: 0.654321, uncertain: true, start: { x: 1, y: 2 }, end: { x: 3, y: 4 } },
      { kind: "text", page: 2, text: "높은 신뢰도도 원본 확인", source: "ocr", confidence: 91.23456, uncertain: false },
    ],
    warnings: ["1페이지 확인 필요: INSERT 등 미지원 요소는 읽지 못했어요.", "3페이지 확인 필요: 읽어낸 요소가 없어요."],
  };
  const copied = JSON.parse(serializeReaderResult(result));
  for (const key of ["pages", "elements", "warnings"]) {
    assert(JSON.stringify(copied[key]) === JSON.stringify(result[key]), `${key}가 누락되거나 변환되었어요.`);
  }
  assert(copied.unit === result.unit && copied.pages.length === 3);
  assert(copied.coordinate_note.includes("페이지 좌표") && copied.coordinate_note.includes("실제 부품의 mm 치수가 아니"));
});
test("복사 계약: 읽기 결과가 없으면 이전 결과 대신 오류", async () => {
  await rejects(() => serializeReaderResult(null), "복사할 읽기 결과가 없어요");
});

async function waitFor(condition, message, timeout = 20000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
let frame;
let app;
async function openApp() {
  frame = document.createElement("iframe");
  frame.id = "test-app";
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  frame.src = "../index.html";
  document.body.append(frame);
  await loaded;
  app = frame.contentDocument;
}
async function selectFile(filename, name = filename) {
  const input = app.querySelector("#file-input");
  const transfer = new frame.contentWindow.DataTransfer();
  transfer.items.add(new frame.contentWindow.File([await fixture(filename)], name));
  input.files = transfer.files;
  input.dispatchEvent(new frame.contentWindow.Event("change", { bubbles: true }));
}
async function startReading() {
  app.querySelector("#start-button").click();
  await waitFor(() => !app.querySelector("#start-button").disabled, "읽기가 끝나지 않았어요.");
}
function confirmSensitive(checked = true) {
  app.querySelector("#sensitive-check").checked = checked;
  app.querySelector("#sensitive-check").dispatchEvent(new frame.contentWindow.Event("change"));
}
function replaceClipboard(clipboard) {
  const navigator = frame.contentWindow.navigator;
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  return () => {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else delete navigator.clipboard;
  };
}
async function copyResult() {
  app.querySelector("#copy-result").click();
  await waitFor(() => !app.querySelector("#sensitive-check").disabled, "복사가 끝나지 않았어요.");
}
test("화면: DXF 업로드·요소 목록·미리보기·돌아가기", async () => {
  await openApp();
  assert(!app.querySelector("#chat-frame iframe") && app.querySelector("#chat-panel").hidden);
  assert(app.querySelector("#copy-result").disabled && app.querySelector("#open-chat").disabled);
  await selectFile("simple.dxf", "EXAMPLE.DXF");
  await startReading();
  assert(!app.querySelector("#review-screen").hidden);
  assert(app.querySelectorAll("#element-list tr").length === 3);
  assert(app.querySelectorAll("#drawing-preview line").length === 1);
  assert(app.querySelectorAll("#drawing-preview circle").length === 1);
  assert(app.querySelector("#drawing-preview text").textContent === "도면 예제");
  assert(!app.querySelector("#chat-frame iframe"), "읽기만으로 외부 채팅을 열면 안 돼요.");
  app.querySelector("#back-button").click();
  assert(!app.querySelector("#upload-screen").hidden);
  assert(!app.querySelector("#element-list").children.length);
  assert(app.querySelector("#copy-data").value === "" && app.querySelector("#copy-result").disabled);
});
test("화면: PDF 읽기·페이지 전환·추정 원 구분", async () => {
  await selectFile("simple.pdf");
  await startReading();
  assert(!app.querySelector("#review-screen").hidden, app.querySelector("#read-error").textContent);
  assert(app.querySelector("#page-select").options.length === 2);
  assert(app.querySelector("#element-list").textContent.includes("확인 필요"));
  app.querySelector("#page-select").value = "2";
  app.querySelector("#page-select").dispatchEvent(new frame.contentWindow.Event("change"));
  assert(app.querySelector("#element-list").textContent.includes("Page two"));
  assert(!app.querySelector("#element-list").textContent.includes("Hello blueprint"));
  const copied = JSON.parse(app.querySelector("#copy-data").value);
  assert(copied.pages.length === 2 && copied.elements.length === 6);
  assert(copied.elements.some((element) => element.page === 1 && element.text === "Hello blueprint"));
  assert(copied.elements.some((element) => element.page === 2 && element.text === "Page two"));
  assert(copied.elements.find((element) => element.kind === "circle").uncertain);
  assert(copied.warnings.some((warning) => warning.includes("곡선은 제외")));
  assert(app.querySelector("#coordinate-note").textContent.includes("실제 부품의 mm 치수가 아니"));
  let clipboardText;
  const restore = replaceClipboard({ writeText: async (text) => { clipboardText = text; } });
  try {
    confirmSensitive();
    await copyResult();
    assert(clipboardText === app.querySelector("#copy-data").value, "현재 페이지와 무관하게 전체 JSON을 복사해야 해요.");
  } finally {
    restore();
  }
  app.querySelector("#back-button").click();
});
test("화면: 스캔 PDF OCR 결과와 확인 필요 안내 표시", async () => {
  const homepage = await fetch("../index.html", { cache: "no-store" }).then((response) => response.text());
  assert(homepage.includes('href="./tests/fixtures/scan.pdf" download>스캔 PDF</a>'),
    "스캔 PDF 예제를 내려받을 수 있어야 해요.");
  await selectFile("scan.pdf");
  await startReading();
  assert(!app.querySelector("#review-screen").hidden, app.querySelector("#read-error").textContent);
  assert(app.querySelector("#element-list").textContent.includes("확인 필요"));
  assert(app.querySelector("#reading-summary").textContent.includes("글자"));
  assert(app.querySelector("#drawing-preview").children.length > 0);
  const copied = JSON.parse(app.querySelector("#copy-data").value);
  const ocr = copied.elements.filter((element) => element.source === "ocr");
  assert(ocr.length > 0 && ocr.every((element) => Number.isFinite(element.confidence) && Object.hasOwn(element, "uncertain")));
  assert(copied.elements.filter((element) => element.source === "image").every((element) => element.uncertain));
  app.querySelector("#back-button").click();
});
test("화면: 손상 PDF는 성공 화면이나 이전 결과를 보여주지 않음", async () => {
  await selectFile("broken.pdf");
  await startReading();
  assert(app.querySelector("#review-screen").hidden);
  assert(app.querySelector("#read-error").textContent.includes("손상"));
  assert(!app.querySelector("#element-list").children.length);
  assert(app.querySelector("#copy-data").value === "" && app.querySelector("#copy-result").disabled);
  assert(app.querySelector("#open-chat").disabled && !app.querySelector("#chat-frame iframe"));
});
test("화면: 파일 이름·글자 내용을 HTML로 실행하지 않음", async () => {
  const transfer = new frame.contentWindow.DataTransfer();
  const text = (await fixtureText("simple.dxf")).replace("도면 예제", "<img src=x onerror=alert(1)>");
  transfer.items.add(new frame.contentWindow.File([text], "<img src=x>.dxf"));
  const input = app.querySelector("#file-input");
  input.files = transfer.files;
  input.dispatchEvent(new frame.contentWindow.Event("change"));
  assert(!app.querySelector("#file-list img"));
  await startReading();
  assert(!app.querySelector("#element-list img"));
  assert(app.querySelector("#element-list").textContent.includes("<img"));
  assert(JSON.parse(app.querySelector("#copy-data").value).elements.some((element) => element.text === "<img src=x onerror=alert(1)>"));
  assert(!app.querySelector("#copy-preview img"));
  app.querySelector("#back-button").click();
});
test("화면: 100개 단위 목록 이동 시 누락 없이 표시", async () => {
  const content = Array.from({ length: 205 }, (_, index) =>
    `0\nLINE\n10\n${index}\n20\n0\n11\n${index}\n21\n10\n`).join("");
  const transfer = new frame.contentWindow.DataTransfer();
  transfer.items.add(new frame.contentWindow.File([dxfEntities(content)], "many.dxf"));
  const input = app.querySelector("#file-input");
  input.files = transfer.files;
  input.dispatchEvent(new frame.contentWindow.Event("change"));
  await startReading();
  assert(app.querySelectorAll("#element-list tr").length === 100);
  app.querySelector("#next-results").click();
  assert(app.querySelector("#result-range").textContent === "101–200 / 205개");
  app.querySelector("#next-results").click();
  assert(app.querySelectorAll("#element-list tr").length === 5);
  assert(JSON.parse(app.querySelector("#copy-data").value).elements.length === 205, "목록의 5개만 복사하면 안 돼요.");
  assert(app.querySelector("#next-results").disabled);
  app.querySelector("#previous-results").click();
  assert(app.querySelectorAll("#element-list tr").length === 100);
  app.querySelector("#back-button").click();
});
test("화면: 지원하지 않는 확장자는 읽기 버튼 비활성화", async () => {
  await selectFile("simple.dxf", "example.txt");
  assert(app.querySelector("#start-button").disabled);
  assert(app.querySelector("#read-error").textContent.includes("DXF 또는 PDF"));
});

test("화면: 민감한 내용 확인 후에만 전체 결과 복사, 복사만으로 채팅을 열지 않음", async () => {
  await selectFile("simple.dxf", "비공개-파일명.dxf");
  await startReading();
  let calls = 0;
  let clipboardText;
  const restore = replaceClipboard({ writeText: async (text) => { calls += 1; clipboardText = text; } });
  try {
    app.querySelector("#copy-result").click();
    assert(calls === 0 && app.querySelector("#copy-result").disabled);
    assert(app.querySelector("#open-chat").disabled);
    confirmSensitive();
    await copyResult();
    assert(calls === 1 && JSON.parse(clipboardText).elements.length === 3);
    assert(!clipboardText.includes("비공개-파일명.dxf"));
    assert(app.querySelector("#copy-status").textContent.includes("아직 외부로 전송하지 않았어요"));
    assert(!app.querySelector("#chat-frame iframe") && !app.querySelector("#open-chat").disabled);
    assert(!frame.contentWindow.performance.getEntriesByType("resource").some((entry) => entry.name.includes("copilotstudio.microsoft.com")));
    confirmSensitive(false);
    assert(app.querySelector("#open-chat").disabled);
  } finally {
    restore();
    app.querySelector("#back-button").click();
  }
});
test("화면: 복사 거부는 오류와 직접 복사 대안을 제공하고, 채팅은 명시적 클릭 때만 생성", async () => {
  await selectFile("simple.dxf");
  await startReading();
  const restore = replaceClipboard({ writeText: async () => { throw new Error("클립보드 권한 거부"); } });
  const createElement = app.createElement;
  let requestedUrl;
  app.createElement = function (name, options) {
    const element = createElement.call(this, name, options);
    if (name.toLowerCase() === "iframe") {
      Object.defineProperty(element, "src", {
        configurable: true,
        set: (url) => { requestedUrl = url; },
        get: () => requestedUrl,
      });
    }
    return element;
  };
  try {
    confirmSensitive();
    await copyResult();
    assert(app.querySelector("#copy-error").textContent.includes("클립보드 권한 거부"));
    assert(app.querySelector("#copy-error").getAttribute("role") === "alert");
    assert(app.querySelector("#copy-preview").open && app.querySelector("#copy-data").readOnly);
    assert(app.activeElement === app.querySelector("#copy-data"), "복사 실패 시 직접 복사 영역에 초점이 있어야 해요.");
    assert(app.querySelector("#copy-data").selectionEnd === app.querySelector("#copy-data").value.length);
    assert(app.querySelector("#copy-status").textContent === "" && app.querySelector("#open-chat").disabled);
    assert(!requestedUrl, "복사 실패로 채팅을 자동 로드하면 안 돼요.");
    app.querySelector("#confirm-manual-copy").click();
    assert(app.querySelector("#copy-status").textContent.includes("직접 복사를 마쳤다고 확인"));
    app.querySelector("#open-chat").click();
    const expectedUrl = "https://copilotstudio.microsoft.com/environments/Default-62ae463a-9f12-4edf-8544-4f6ca3834524/bots/cre4a_bot_GA1WSN/webchat?__version__=2&enableFileAttachment=false&cliAgent=true";
    assert(requestedUrl === expectedUrl);
    assert(app.querySelector("#chat-frame iframe").getAttribute("src") === null, "자동 검사는 실제 Microsoft 접속을 하지 않아야 해요.");
    assert(!app.querySelector("#chat-panel").hidden);
    assert(app.querySelector("#open-chat").getAttribute("aria-expanded") === "true");
    assert(app.querySelector("#chat-frame iframe").title.includes("도면 분석"));
    assert(app.querySelector("#chat-frame iframe").referrerPolicy === "no-referrer");
    assert(app.querySelector("#chat-external-link").href === expectedUrl);
    assert(app.activeElement === app.querySelector("#chat-title"));
    app.querySelector("#open-chat").click();
    assert(app.querySelectorAll("#chat-frame iframe").length === 1);
    app.querySelector("#close-chat").click();
    assert(!app.querySelector("#chat-frame iframe") && app.querySelector("#chat-panel").hidden);
    assert(app.querySelector("#open-chat").getAttribute("aria-expanded") === "false");
    assert(!app.querySelector("#chat-external-link").hasAttribute("href"));
    app.querySelector("#open-chat").click();
    assert(app.querySelector("#chat-frame iframe"));
    await selectFile("broken.pdf");
    assert(!app.querySelector("#chat-frame iframe") && app.querySelector("#copy-data").value === "");
    assert(app.querySelector("#copy-result").disabled && app.querySelector("#open-chat").disabled);
    await startReading();
    assert(app.querySelector("#review-screen").hidden && app.querySelector("#copy-data").value === "");
  } finally {
    app.createElement = createElement;
    restore();
    app.querySelector("#back-button").click();
  }
});
test("화면: Clipboard API 미지원도 성공으로 숨기지 않고 직접 복사 안내", async () => {
  await selectFile("simple.dxf");
  await startReading();
  const restore = replaceClipboard(undefined);
  try {
    confirmSensitive();
    await copyResult();
    assert(app.querySelector("#copy-error").textContent.includes("자동 복사를 지원하지 않아요"));
    assert(app.querySelector("#copy-preview").open && app.querySelector("#open-chat").disabled);
    app.querySelector("#select-copy-data").click();
    assert(app.querySelector("#copy-data").selectionStart === 0);
    assert(app.querySelector("#copy-data").selectionEnd === app.querySelector("#copy-data").value.length);
  } finally {
    restore();
    app.querySelector("#back-button").click();
  }
});
test("화면: 복사 처리 중 파일 재선택·읽기 실패 뒤 늦은 완료가 이전 결과를 되살리지 않음", async () => {
  await selectFile("simple.dxf");
  await startReading();
  let finishCopy;
  const restore = replaceClipboard({ writeText: () => new Promise((resolve) => { finishCopy = resolve; }) });
  try {
    confirmSensitive();
    app.querySelector("#copy-result").click();
    assert(app.querySelector("#sensitive-check").disabled);
    await selectFile("broken.pdf");
    assert(app.querySelector("#copy-data").value === "" && app.querySelector("#copy-result").disabled);
    await startReading();
    finishCopy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(app.querySelector("#copy-status").textContent === "");
    assert(app.querySelector("#copy-data").value === "");
    assert(app.querySelector("#copy-result").disabled && app.querySelector("#open-chat").disabled);
    assert(!app.querySelector("#chat-frame iframe"));
  } finally {
    restore();
    app.querySelector("#back-button").click();
  }
});
test("화면: 공개 채팅·외부 처리·크레딧·파일 첨부 및 길이 한계 안내", () => {
  const privacy = app.querySelector("#transfer-privacy").textContent;
  for (const text of ["Microsoft에 접속", "로그인 없이", "크레딧", "비용", "Microsoft에서 처리", "원본 파일", "파일 첨부도 지원하지 않아요"]) {
    assert(privacy.includes(text), `${text} 안내가 필요해요.`);
  }
  assert(app.querySelector("#chat-panel").textContent.includes("임의로 잘라 보내지 말고"));
  assert(app.querySelector("#copy-help").textContent.includes("설계 적합성 판정이 아니"));
  assert(app.querySelector("#open-chat").getAttribute("aria-controls") === "chat-panel");
  assert(app.querySelector("#copy-data").labels.length === 1 && app.querySelector("#sensitive-check").labels.length === 1);
});
test("화면: 모바일 360px에서 전체 결과 확인·복사 버튼·채팅 영역이 화면을 넘지 않음", async () => {
  frame.style.width = "360px";
  try {
    await selectFile("simple.dxf");
    await startReading();
    app.querySelector("#copy-preview").open = true;
    app.querySelector("#chat-panel").hidden = false;
    const placeholder = app.createElement("iframe");
    placeholder.title = "자동 검사용 빈 채팅 화면";
    app.querySelector("#chat-frame").append(placeholder);
    await new Promise((resolve) => frame.contentWindow.requestAnimationFrame(resolve));
    const viewportWidth = app.documentElement.clientWidth;
    assert(frame.contentWindow.innerWidth === 360, `모바일 검사 창 너비: ${frame.contentWindow.innerWidth}px`);
    assert(app.documentElement.scrollWidth <= viewportWidth, `화면 너비 ${viewportWidth}px, 내용 너비 ${app.documentElement.scrollWidth}px`);
    for (const selector of ["#copy-data", "#copy-result", "#open-chat", "#chat-frame iframe"]) {
      const bounds = app.querySelector(selector).getBoundingClientRect();
      assert(bounds.left >= 0 && bounds.right <= viewportWidth, `${selector}가 모바일 화면 밖으로 나갔어요.`);
    }
    assert(app.querySelector("#copy-result").getBoundingClientRect().height >= 44);
    assert(app.querySelector("#open-chat").getBoundingClientRect().height >= 44);
    assert(!frame.contentWindow.performance.getEntriesByType("resource").some((entry) => entry.name.includes("copilotstudio.microsoft.com")));
  } finally {
    frame.style.width = "";
    app.querySelector("#back-button").click();
  }
});

for (const { name, action } of tests) {
  const item = document.createElement("li");
  try {
    await action();
    window.testResults.passed += 1;
    item.className = "pass";
    item.textContent = `통과: ${name}`;
  } catch (error) {
    window.testResults.failed += 1;
    window.testResults.failures.push({ name, error: error.stack ?? error.message });
    item.className = "fail";
    item.textContent = `실패: ${name} — ${error.message}`;
    console.error(name, error);
  }
  document.querySelector("#results").append(item);
}
frame?.remove();
window.testResults.done = true;
document.querySelector("#status").textContent = `${window.testResults.passed}개 통과, ${window.testResults.failed}개 실패`;
