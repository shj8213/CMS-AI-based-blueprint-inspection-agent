import { readDxf } from "../src/dxf.js";
import { readPdf } from "../src/pdf.js";
import { inferCircle, multiply, transform } from "../src/geometry.js";
import { detectScanGeometry, pageScaleForScan } from "../src/scan.js";
import { reviewFitNotation } from "../src/fit-review.js";

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
async function rejects(action, message) {
  let caught;
  try { await action(); } catch (error) { caught = error; }
  assert(caught && caught.message.includes(message), `오류에 '${message}'가 필요해요. 실제: ${caught?.message ?? "오류 없음"}`);
}
function dxfEntities(content) {
  return encode(`0\nSECTION\n2\nENTITIES\n${content}0\nENDSEC\n0\nEOF\n`);
}

function dxfText(text) {
  return dxfEntities(`0\nTEXT\n10\n20\n20\n30\n40\n12\n1\n${text}\n`);
}

test("끼워맞춤: DXF 후보·위치·근거와 규격 위반이 아니라는 설명", () => {
  const review = reviewFitNotation(readDxf(dxfText("Ø20H7/g6 및 H8 / f7")));
  assert(review.state === "문제 후보");
  assert(review.candidates.length === 2);
  assert(review.candidates[0].notation === "H7/g6");
  near(review.candidates[0].evidence[0].position.x, 20);
  assert(review.candidates[0].evidence[0].text.includes("Ø20"));
  assert(review.reason.includes("오류라는 뜻은 아니"));
  assert(review.limit.includes("KS"));
});
test("끼워맞춤: 신뢰할 수 있는 DXF 글자에 후보가 없을 때만 이상 없음", () => {
  const review = reviewFitNotation(readDxf(dxfText("도면 예제 h7/G6 H7 H7/g6abc ABCD7/g6")));
  assert(review.state === "이상 없음");
  assert(review.checkedTexts === 1 && review.candidates.length === 0);
});
test("끼워맞춤: 미지원 요소·서식·글자 없는 DXF는 확인할 수 없음", () => {
  const samples = [
    dxfEntities("0\nLINE\n10\n0\n20\n0\n11\n10\n21\n10\n"),
    dxfEntities("0\nTEXT\n10\n0\n20\n0\n40\n12\n1\n예제\n0\nINSERT\n2\nBLOCK\n"),
    dxfText("\\S표기;"),
    dxfEntities("0\nMTEXT\n10\n0\n20\n0\n40\n12\n1\n\\SH7/g6;\n"),
  ];
  for (const sample of samples) assert(reviewFitNotation(readDxf(sample)).state === "확인할 수 없음");
});
test("끼워맞춤: DXF 글자 정렬 경고는 후보 없음 판단을 막지 않음", () => {
  const result = readDxf(dxfEntities("0\nMTEXT\n10\n0\n20\n0\n40\n12\n1\n도면\\P예제\n"));
  assert(result.warnings.length > 0);
  assert(reviewFitNotation(result).state === "이상 없음");
});
test("끼워맞춤: 일반 PDF의 도형 경고와 무관하게 글자 확인", async () => {
  const result = await readPdf(await fixture("simple.pdf"));
  assert(result.warnings.length > 0);
  assert(reviewFitNotation(result).state === "이상 없음");
});
test("끼워맞춤: 실제 PDF에서 표기 후보와 페이지·위치 보존", async () => {
  const result = await readPdf(await fixture("fit.pdf"));
  const review = reviewFitNotation(result);
  assert(review.state === "문제 후보");
  assert(review.candidates[0].notation === "H7/g6");
  assert(review.candidates[0].evidence[0].page === 1);
  near(review.candidates[0].evidence[0].position.x, 20);
  near(review.candidates[0].evidence[0].position.y, 50);
});
test("끼워맞춤: 실제 DXF 예제에서 후보를 찾고 읽기 결과를 바꾸지 않음", async () => {
  const result = readDxf(await fixture("fit.dxf"));
  const before = JSON.stringify(result);
  const review = reviewFitNotation(result);
  assert(review.state === "문제 후보");
  assert(review.candidates[0].notation === "H7/g6");
  near(review.candidates[0].evidence[0].position.y, 30);
  assert(JSON.stringify(result) === before);
});
test("끼워맞춤: 분리된 PDF 글자와 OCR 단어를 인접한 같은 행에서만 연결", () => {
  for (const source of [undefined, "ocr"]) {
    const result = {
      format: "PDF", textCoverage: { reasons: [] },
      elements: ["H7", "/", "g6"].map((text, index) => ({
        kind: "text", text, page: 2, position: { x: 20 + index * 20, y: 30 },
        width: 18, height: 12, rotation: 0, source, confidence: 90, uncertain: false,
      })),
    };
    const review = reviewFitNotation(result);
    assert(review.state === "문제 후보" && review.candidates[0].evidence.length === 3);
    result.elements[2].position.y = 100;
    assert(reviewFitNotation(result).candidates.length === 0);
    result.elements[2].position.y = 30;
    result.elements[2].page = 3;
    assert(reviewFitNotation(result).candidates.length === 0);
  }
});
test("끼워맞춤: 낮은·누락된 OCR 신뢰도와 불확실한 후보는 이상 없음·문제 후보로 단정하지 않음", () => {
  for (const confidence of [20, undefined, 90]) {
    for (const text of ["H7/g6", "읽은 글자"]) {
      const result = {
        format: "PDF", textCoverage: { reasons: ["이미지 글자 범위를 확신할 수 없어요."] },
        elements: [{
          kind: "text", text, position: { x: 20, y: 30 }, page: 1,
          source: "ocr", confidence, uncertain: confidence === 90,
        }],
      };
      assert(reviewFitNotation(result).state === "확인할 수 없음");
    }
  }
});
test("끼워맞춤: 실제 스캔·혼합 PDF는 미발견을 이상 없음으로 처리하지 않음", async () => {
  for (const name of ["scan.pdf", "mixed.pdf"]) {
    const review = reviewFitNotation(await readPdf(await fixture(name)));
    assert(review.state === "확인할 수 없음");
    assert(review.reasons.some((reason) => reason.includes("이미지")));
  }
});
test("끼워맞춤: 높은 OCR 신뢰도도 이미지의 검사 범위 보장은 아니며, 확실한 후보는 따로 표시", () => {
  const result = {
    format: "PDF", textCoverage: { reasons: ["이미지 전체의 글자를 확인하지 못했어요."] },
    elements: [{
      kind: "text", text: "표기 없음", position: { x: 20, y: 30 }, page: 1,
      source: "ocr", confidence: 95, uncertain: false,
    }],
  };
  assert(reviewFitNotation(result).state === "확인할 수 없음");
  result.elements[0].text = "H7/g6";
  const review = reviewFitNotation(result);
  assert(review.state === "문제 후보" && review.reasons.length === 1);
  result.elements[0].source = undefined;
  result.elements[0].uncertain = true;
  assert(reviewFitNotation(result).state === "확인할 수 없음");
});

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
  const text = new TextDecoder().decode(await fixture("simple.dxf"));
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
  const text = new TextDecoder().decode(await fixture("simple.dxf"));
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
test("화면: DXF 업로드·요소 목록·미리보기·돌아가기", async () => {
  await openApp();
  await selectFile("simple.dxf", "EXAMPLE.DXF");
  await startReading();
  assert(!app.querySelector("#review-screen").hidden);
  assert(app.querySelectorAll("#element-list tr").length === 3);
  assert(app.querySelectorAll("#drawing-preview line").length === 1);
  assert(app.querySelectorAll("#drawing-preview circle").length === 1);
  assert(app.querySelector("#drawing-preview text").textContent === "도면 예제");
  assert(app.querySelector("#fit-state").textContent === "이상 없음");
  assert(app.querySelector("#fit-scope").textContent.includes("글자 1개"));
  assert(app.querySelector("#fit-limit").textContent.includes("KS"));
  app.querySelector("#back-button").click();
  assert(!app.querySelector("#upload-screen").hidden);
  assert(!app.querySelector("#element-list").children.length);
  assert(!app.querySelector("#fit-state").textContent);
});
test("화면: 끼워맞춤 후보의 상태·위치·근거 표시", async () => {
  for (const [file, location] of [["fit.pdf", "1페이지"], ["fit.dxf", "DXF 모형 공간"]]) {
    await selectFile(file);
    await startReading();
    assert(app.querySelector("#fit-state").textContent === "문제 후보");
    const evidence = app.querySelector("#fit-candidates").textContent;
    assert(evidence.includes("H7/g6") && evidence.includes(location) && evidence.includes("(20,"));
    assert(app.querySelector("#fit-reason").textContent.includes("규격 위반"));
    app.querySelector("#back-button").click();
    assert(!app.querySelector("#fit-candidates").children.length);
  }
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
  assert(app.querySelector("#fit-state").textContent === "확인할 수 없음");
  assert(app.querySelector("#fit-warnings").textContent.includes("이미지"));
  app.querySelector("#back-button").click();
});
test("화면: 손상 PDF는 성공 화면이나 이전 결과를 보여주지 않음", async () => {
  await selectFile("broken.pdf");
  await startReading();
  assert(app.querySelector("#review-screen").hidden);
  assert(app.querySelector("#read-error").textContent.includes("손상"));
  assert(!app.querySelector("#element-list").children.length);
  assert(!app.querySelector("#fit-state").textContent);
});
test("화면: 파일 이름·글자 내용을 HTML로 실행하지 않음", async () => {
  const transfer = new frame.contentWindow.DataTransfer();
  const text = new TextDecoder().decode(await fixture("simple.dxf")).replace("도면 예제", "<img src=x onerror=alert(1)>");
  transfer.items.add(new frame.contentWindow.File([text], "<img src=x>.dxf"));
  const input = app.querySelector("#file-input");
  input.files = transfer.files;
  input.dispatchEvent(new frame.contentWindow.Event("change"));
  assert(!app.querySelector("#file-list img"));
  await startReading();
  assert(!app.querySelector("#element-list img"));
  assert(app.querySelector("#element-list").textContent.includes("<img"));
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
