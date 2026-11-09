import { readDxf } from "../src/dxf.js";
import { readPdf } from "../src/pdf.js";
import { inferCircle, multiply, transform } from "../src/geometry.js";
import { detectScanGeometry, pageScaleForScan } from "../src/scan.js";
import { createAgentResultModel, displayValue, parseAgentResult } from "../src/agent-result.js";
import { analyzeDrawingWithStudio } from "../src/studio-connection.js";
import { createAnalysisHistory, fileFingerprint } from "../src/analysis-history.js";
import { buildReferenceExamples } from "../src/reference-examples.js";

const TEST_HISTORY_KEY = "blueprint-analysis-history-test";
localStorage.removeItem(TEST_HISTORY_KEY);
window.testResults = { done: false, passed: 0, failed: 0, failures: [] };
const tests = [];
const agentOnly = new URLSearchParams(window.location.search).get("agent") === "1";
const test = (name, action) => { if (!agentOnly) tests.push({ name, action }); };
const agentTest = (name, action) => tests.push({ name, action });
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
  frame.src = "../index.html?history=test";
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
  app.querySelector("#back-button").click();
  assert(!app.querySelector("#upload-screen").hidden);
  assert(!app.querySelector("#element-list").children.length);
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
  app.querySelector("#back-button").click();
});
test("화면: 손상 PDF는 성공 화면이나 이전 결과를 보여주지 않음", async () => {
  await selectFile("broken.pdf");
  await startReading();
  assert(app.querySelector("#review-screen").hidden);
  assert(app.querySelector("#read-error").textContent.includes("손상"));
  assert(!app.querySelector("#element-list").children.length);
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

async function agentFixture() {
  return new TextDecoder().decode(await fixture("agent-result.json"));
}
async function showAgentResult(text) {
  const input = app.querySelector("#agent-result-input");
  const button = app.querySelector("#agent-result-show");
  input.value = text;
  input.dispatchEvent(new frame.contentWindow.Event("input", { bubbles: true }));
  button.click();
  await waitFor(() => !button.disabled, "② 결과 표시가 끝나지 않았어요.");
}

agentTest("② 결과: JSON만 또는 총 분석과 JSON 코드 블록 함께 읽기", async () => {
  const json = await agentFixture();
  const raw = parseAgentResult(json);
  assert(raw.summary === "" && raw.data.schema_version === "1.2");
  const response = `총 분석\n가상 결과를 확인해 주세요.\n\n\`\`\`json\n${json}\n\`\`\``;
  const parsed = parseAgentResult(response);
  assert(parsed.summary.includes("가상 결과") && parsed.data.features.length === 2);
  const noLanguage = parseAgentResult(`총 분석\r\n가상 요약\r\n\`\`\`\r\n${json}\r\n\`\`\``);
  assert(noLanguage.summary.includes("가상 요약"));
  assert(parseAgentResult('{"status":"완료","limitations":["```"]}').data.limitations[0] === "```");
  const withBraces = JSON.parse(json);
  withBraces.elements[0].raw_text = '가상 {"기호": "}" }';
  const renderedText = `총 분석\n가상 {설명} 요약\n${JSON.stringify(withBraces)}\n추가 설명`;
  const withoutFence = parseAgentResult(renderedText);
  assert(withoutFence.data.elements[0].raw_text === withBraces.elements[0].raw_text);
  assert(withoutFence.summary.includes("가상 {설명} 요약") && withoutFence.summary.includes("추가 설명"));
});

agentTest("② 결과: 문법 오류·다른 형식·잘못된 목록은 쉬운 안내", async () => {
  await rejects(() => parseAgentResult(""), "먼저 붙여 넣어");
  await rejects(() => parseAgentResult('{"status":'), "JSON 형식");
  await rejects(() => parseAgentResult("{}"), "② 분석 결과 형식");
  await rejects(() => parseAgentResult('{"status":"완료","elements":"목록 아님"}'), "읽은 요소");
  await rejects(() => parseAgentResult('{"status":"완료","pages":[{"views":[null]}]}'), "뷰");
  await rejects(() => parseAgentResult('{"status":"완료","elements":[{"needs_confirmation":"false"}]}'), "true 또는 false");
  await rejects(() => parseAgentResult('```json\n{"status":"완료"}'), "코드 블록");
  await rejects(() => parseAgentResult('```json\n{"status":"완료"}\n```\n```json\n{"status":"완료"}\n```'), "여러 개");
});

agentTest("② 결과: 확인 필요·판독 범위·형상 연결과 없는 값 구분", async () => {
  const parsed = parseAgentResult(await agentFixture());
  parsed.data.status = "완료";
  parsed.data.pages[0].views.push({ id: "V3", type: "상세도", read_coverage: null });
  parsed.data.features[0].attributes.push({
    name: "가상 속성", linked_element_ids: ["E404"], link_status: "연결됨",
  });
  parsed.data.stage_log = parsed.data.stage_log.filter((stage) => stage.stage !== 6);
  const model = createAgentResultModel(parsed);
  const messages = model.confirmations.map((item) => `${item.source} ${item.message}`).join("\n");
  assert(model.coverage.enlarged === 1 && model.coverage.overview === 1 && model.coverage.unknown === 1);
  assert(messages.includes("전체 상태는 완료지만") && messages.includes("2페이지"));
  assert(messages.includes("계산 가능") && messages.includes("발견하지 못함"));
  assert(messages.includes("연결된 요소 E404") && messages.includes("치수에 연결된 형상 속성 기록이 없어요"));
  assert(messages.includes("6단계") && model.stages.length === 6);
  assert(model.links.get("E01")[0].feature.id === "F01");
  assert(displayValue(0) === "0" && displayValue(null) === "없음" && displayValue(undefined) === "확인 필요");
  assert(displayValue([]) === "없음");
});

agentTest("② 결과: 기록이 빠진 항목은 없는 것으로 단정하지 않음", async () => {
  const parsed = parseAgentResult(await agentFixture());
  delete parsed.data.source.unanalyzed_pages;
  delete parsed.data.pages[0].views[0].read_coverage;
  delete parsed.data.elements[0].needs_confirmation;
  delete parsed.data.features[0].attributes[0].link_status;
  delete parsed.data.limitations;
  const messages = createAgentResultModel(parsed).confirmations.map((item) => item.message).join("\n");
  assert(messages.includes("분석하지 못한 페이지 목록이 기록되지 않았어요"));
  assert(messages.includes("확인 상태 미기록") && messages.includes("연결 상태: 확인 필요"));
  assert(messages.includes("판독 범위: 확인 필요") && messages.includes("판독 한계 목록이 기록되지 않았어요"));
});

agentTest("② 결과: 빠진 위치·중복 번호·잘못 연결된 합계를 확인 필요로 표시", async () => {
  const parsed = parseAgentResult(await agentFixture());
  parsed.data.pages[0].views[0].id = null;
  parsed.data.elements[0].view_id = null;
  parsed.data.elements.push({ ...parsed.data.elements[0] });
  parsed.data.features.push({ ...parsed.data.features[0] });
  parsed.data.dimension_chains[0].element_ids = ["E404"];
  parsed.data.dimension_chains[0].overall_element_id = "E404";
  const messages = createAgentResultModel(parsed).confirmations.map((item) => item.message).join("\n");
  assert(messages.includes("뷰 번호가 기록되지 않았어요") && messages.includes("페이지 또는 뷰가 기록되지 않았어요"));
  assert(messages.includes("같은 요소 번호") && messages.includes("같은 형상 번호"));
  assert(messages.includes("사용한 요소 E404") && messages.includes("전체 치수 E404"));
  assert(messages.includes("치수 원문이 비어 있어"));
});

agentTest("화면: 도면 없이 ② 결과만 열고 붙여 넣은 내용을 전송하지 않음", async () => {
  if (!app) await openApp();
  const json = await agentFixture();
  app.querySelector("#agent-result-only").click();
  assert(!app.querySelector("#review-screen").hidden);
  assert(app.querySelector(".reading-results").hidden && app.querySelector(".review-layout").hidden);
  assert(app.querySelector("#selected-file-name").textContent.includes("선택한 도면 없이"));
  const originalFetch = frame.contentWindow.fetch;
  let requests = 0;
  frame.contentWindow.fetch = (...args) => {
    requests += 1;
    return originalFetch.apply(frame.contentWindow, args);
  };
  try {
    await showAgentResult(json);
    assert(!app.querySelector("#agent-result-output").hidden);
    assert(requests === 0, "결과 표시 중 데이터를 요청하지 않아야 해요.");
  } finally {
    frame.contentWindow.fetch = originalFetch;
  }
  app.querySelector("#back-button").click();
  assert(!app.querySelector("#upload-screen").hidden);
  assert(app.querySelector("#agent-result-input").value === "");
});

agentTest("화면: ② 요약·확인 필요·6단계·형상·치수·공차·표제란 표시", async () => {
  if (!app) await openApp();
  await selectFile("simple.dxf");
  await startReading();
  assert(!app.querySelector("#review-screen").hidden);
  const json = await agentFixture();
  await showAgentResult(`총 분석\n가상 도면의 일부는 확인이 필요해요.\n\n\`\`\`json\n${json}\n\`\`\``);
  assert(!app.querySelector("#agent-result-output").hidden, app.querySelector("#agent-result-error").textContent);
  assert(app.querySelector("#agent-summary").textContent.includes("가상 도면"));
  assert(app.querySelector("#agent-status").textContent === "부분 완료");
  assert(app.querySelector("#agent-file-name").textContent === "가상-축-예제.pdf");
  assert(app.querySelector("#agent-pages").textContent.includes("분석하지 못함: 2"));
  assert(app.querySelector("#agent-coverage").textContent.includes("확대 판독 1 · 전체 이미지만 1"));
  const confirmations = app.querySelector("#agent-confirmations").textContent;
  assert(confirmations.includes("V2") && confirmations.includes("계산 가능") && confirmations.includes("E02"));
  assert(app.querySelectorAll("#agent-stages tbody tr").length === 6);
  assert(app.querySelector("#agent-features").textContent.includes("h7"));
  const dimension = [...app.querySelectorAll("#agent-dimensions tbody tr")].find((row) => row.textContent.includes("E01"));
  assert(dimension && dimension.textContent.includes("Ø20h7") && dimension.textContent.includes("F01"));
  assert(dimension.textContent.includes("좌표: (0, 20)") && dimension.textContent.includes("범위: 0, 15, 10, 25"));
  assert(app.querySelector("#agent-specifications").textContent.includes("⌀0.1 | A"));
  assert(app.querySelector("#agent-specifications").textContent.includes("Ra 1.6"));
  assert(app.querySelector("#agent-other-elements").textContent.includes("재질 | 예시 재질"));
  assert(app.querySelector("#agent-other-elements").textContent.includes("단위: mm"));
  assert(app.querySelector("#agent-chains").textContent.includes("차이: 0"));
  for (let details = app.querySelector("#agent-dimensions").closest("details"); details;
    details = details.parentElement.closest("details")) details.open = true;
  const scroll = app.querySelector("#agent-dimensions .table-scroll");
  scroll.style.width = "240px";
  assert(scroll.scrollWidth > scroll.clientWidth, "좁은 화면에서 표를 가로로 볼 수 있어야 해요.");
  scroll.style.width = "";
});

agentTest("화면: ② 입력 오류를 알리고 이전 결과 대신 새 입력으로 재시도", async () => {
  await showAgentResult('{"status":');
  assert(app.querySelector("#agent-result-output").hidden);
  assert(app.querySelector("#agent-result-error").textContent.includes("JSON 형식"));
  assert(!app.querySelector("#agent-result-show").disabled);
  await showAgentResult('{"status":"완료","elements":"목록 아님"}');
  assert(app.querySelector("#agent-result-error").textContent.includes("읽은 요소"));
  await showAgentResult(await agentFixture());
  assert(!app.querySelector("#agent-result-output").hidden);
  assert(app.querySelector("#agent-summary").textContent.includes("총 분석 문장이 없어요"));
  assert(!app.querySelector("#agent-result-error").textContent);
  app.querySelector("#agent-result-input").dispatchEvent(new frame.contentWindow.Event("input", { bubbles: true }));
  assert(app.querySelector("#agent-result-output").hidden);
  assert(app.querySelector("#agent-result-progress").textContent.includes("다시 눌러"));
});

agentTest("화면: ② 응답에 섞인 HTML을 실행하지 않고 글자로 표시", async () => {
  const data = JSON.parse(await agentFixture());
  data.source.file_name = "<svg onload=alert(1)>";
  data.elements[0].raw_text = "<img src=x onerror=alert(1)>";
  data.stage_log[0].issues[0] = "<script>alert(1)</script>";
  const response = `총 분석\n<strong>가상 요약</strong>\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\``;
  await showAgentResult(response);
  const output = app.querySelector("#agent-result-output");
  assert(!output.hidden && !output.querySelector("img, script, svg"));
  assert(output.textContent.includes("<img") && output.textContent.includes("<script>"));
  assert(app.querySelector("#agent-summary").textContent.includes("<strong>가상 요약</strong>"));
});

agentTest("화면: 10만 글자 이상의 ② 결과도 50개씩 표시하고 목록 이동", async () => {
  const data = JSON.parse(await agentFixture());
  const count = 650;
  data.elements = Array.from({ length: count }, (_, index) => ({
    id: `L${index}`, page_number: 1, view_id: "V1", category: "치수",
    raw_text: `가상 치수 ${index} ${"가".repeat(200)}`, value: index, unit: "mm",
    location: { description: "가상 위치" }, evidence: "가상 기록", confidence: "높음", needs_confirmation: false,
  }));
  data.features = [{
    id: "F-긴목록", view_ids: ["V1"], type: "가상 형상", description: "목록 길이 시험",
    confidence: "높음", needs_confirmation: false,
    attributes: data.elements.map((element) => ({
      name: "길이", linked_element_ids: [element.id], link_status: "연결됨",
      tolerance_text: null, derivation: null, evidence: "가상 기록",
    })),
  }];
  const text = JSON.stringify(data);
  assert(text.length >= 100000, `긴 예제 글자 수: ${text.length}`);
  let yielded = false;
  frame.contentWindow.setTimeout(() => { yielded = true; }, 0);
  const start = performance.now();
  await showAgentResult(text);
  const elapsed = Math.round(performance.now() - start);
  window.agentLongTest = { characters: text.length, elapsedMs: elapsed };
  assert(yielded && elapsed < 5000, `긴 결과를 표시하는 데 ${elapsed}ms가 걸렸어요.`);
  assert(!app.querySelector("#agent-result-output").hidden, app.querySelector("#agent-result-error").textContent);
  assert(app.querySelectorAll("#agent-dimensions tbody tr").length === 50);
  assert(app.querySelector("#agent-dimensions-range").textContent === `1–50 / ${count}개`);
  assert(app.querySelector("#agent-features-range").textContent === `1–50 / ${count}개`);
  const next = app.querySelector("#agent-dimensions-next");
  next.click();
  assert(app.querySelector("#agent-dimensions-range").textContent === `51–100 / ${count}개`);
  while (!next.disabled) next.click();
  assert(app.querySelector("#agent-dimensions-range").textContent === `601–650 / ${count}개`);
  app.querySelector("#agent-dimensions-previous").click();
  assert(app.querySelector("#agent-dimensions-range").textContent === `551–600 / ${count}개`);
});

agentTest("화면: 도면을 다시 선택하면 ② 입력과 이전 표시 결과 제거", async () => {
  app.querySelector("#back-button").click();
  assert(app.querySelector("#agent-result-input").value === "");
  assert(app.querySelector("#agent-result-output").hidden);
  assert(!app.querySelector("#agent-dimensions").children.length);
  assert(!app.querySelector("#agent-summary").textContent && !app.querySelector("#agent-file-name").textContent);
  assert([...app.querySelectorAll("#agent-result-panel details")].every((details) => !details.open));
  await selectFile("simple.dxf");
  await startReading();
  assert(app.querySelector("#agent-result-output").hidden);
  app.querySelector("#back-button").click();
});

const testTokenEndpoint = "https://example.environment.api.powerplatform.com/copilotstudio/agenticruntime/botsbyschema/example/directline/token?api-version=2022-03-01-preview";

function studioMock({
  tokenEndpoint = testTokenEndpoint,
  region = "https://unitedstates.directline.botframework.com/",
  configStatus = 200,
  tokenStatus = 200,
  uploadStatus = 200,
  activityPages = [],
} = {}) {
  const requests = [];
  let page = 0;
  const response = (data, status = 200) => new Response(data === null ? null : JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  async function fetchImpl(target, options = {}) {
    const url = new URL(String(target), location.href);
    requests.push({ url, options });
    if (url.pathname.endsWith("/agent-connection.local.json")) {
      return response(configStatus === 200 ? { tokenEndpoint } : null, configStatus);
    }
    if (url.pathname.endsWith("/regionalchannelsettings")) {
      return response({ channelUrlsById: { directline: region } });
    }
    if (url.pathname.endsWith("/directline/token")) {
      return response(tokenStatus === 200 ? { token: "test-token" } : null, tokenStatus);
    }
    if (url.pathname === "/v3/directline/conversations") {
      return response({ conversationId: "test-conversation", token: "test-conversation-token" }, 201);
    }
    if (url.pathname.endsWith("/upload")) {
      return response(uploadStatus === 200 ? { id: "sent-1" } : null, uploadStatus);
    }
    if (url.pathname.endsWith("/activities")) {
      return response(activityPages[page++] ?? { activities: [], watermark: String(page) });
    }
    throw new Error("예상하지 못한 연결 요청이에요.");
  }
  return { fetchImpl, requests };
}

function testPdf() {
  return new File(["가상 PDF 내용"], "가상.pdf", { type: "application/pdf" });
}

agentTest("② 연결: PDF와 요청을 보내고 최종 응답을 모아 반환", async () => {
  const mock = studioMock({
    activityPages: [
      { watermark: "1", activities: [
        { id: "user-1", type: "message", text: "사용자 요청" },
        { id: "other-1", type: "message", replyToId: "other", text: "다른 응답" },
        { id: "answer-1", type: "message", replyToId: "sent-1", text: "총 분석\n가상 요약" },
      ] },
      { watermark: "2", activities: [
        { id: "answer-1", type: "message", replyToId: "sent-1", text: "총 분석\n가상 요약" },
        { id: "answer-2", type: "message", replyToId: "sent-1", text: '{"status":"완료"}' },
        { type: "event", name: "turn.complete", replyToId: "sent-1" },
      ] },
    ],
  });
  const progress = [];
  const result = await analyzeDrawingWithStudio(testPdf(), {
    fetchImpl: mock.fetchImpl, onProgress: (message) => progress.push(message), pollIntervalMs: 1, timeoutMs: 1000,
  });
  assert(result === '총 분석\n가상 요약\n\n{"status":"완료"}');
  assert(progress.some((message) => message.includes("PDF를 ②에 보내는 중")));
  const upload = mock.requests.find(({ url }) => url.pathname.endsWith("/upload"));
  assert(upload && upload.url.searchParams.get("userId").startsWith("dl_"));
  const file = upload.options.body.get("file");
  assert(file.name === "가상.pdf" && file.type === "application/pdf" && await file.text() === "가상 PDF 내용");
  const activity = JSON.parse(await upload.options.body.get("activity").text());
  assert(activity.type === "message" && activity.from.id === upload.url.searchParams.get("userId"));
  assert(activity.text.includes("첨부한 도면"));
  const polls = mock.requests.filter(({ url }) => url.pathname.endsWith("/activities"));
  assert(polls.length === 2 && polls[1].url.searchParams.get("watermark") === "1");
  assert(mock.requests.every(({ options }) => options.credentials === "omit" && options.redirect === "error"));
});

agentTest("② 연결: 지원하지 않는 파일·빈 PDF·크기 초과는 보내지 않음", async () => {
  const mock = studioMock();
  await rejects(() => analyzeDrawingWithStudio(new File(["x"], "도면.dxf"), { fetchImpl: mock.fetchImpl }), "PDF만");
  await rejects(() => analyzeDrawingWithStudio(new File([], "빈.pdf"), { fetchImpl: mock.fetchImpl }), "빈 파일");
  await rejects(() => analyzeDrawingWithStudio({ name: "큰.pdf", size: 16 * 1024 * 1024 + 1 }, {
    fetchImpl: mock.fetchImpl,
  }), "16MiB");
  assert(mock.requests.length === 0, "잘못된 파일을 보내면 안 돼요.");
});

agentTest("② 연결: 설정이 없거나 안전하지 않은 연결 주소는 중단", async () => {
  const missing = studioMock({ configStatus: 404 });
  await rejects(() => analyzeDrawingWithStudio(testPdf(), { fetchImpl: missing.fetchImpl }), "연결 설정이 없어요");
  assert(missing.requests.length === 1);
  const invalid = studioMock({ tokenEndpoint: "https://example.environment.api.powerplatform.com.evil.example/token" });
  await rejects(() => analyzeDrawingWithStudio(testPdf(), { fetchImpl: invalid.fetchImpl }), "Microsoft ② 연결 주소");
  assert(invalid.requests.length === 1, "다른 주소로 연결하면 안 돼요.");
  const invalidRegion = studioMock({ region: "https://directline.botframework.com.evil.example/" });
  await rejects(() => analyzeDrawingWithStudio(testPdf(), { fetchImpl: invalidRegion.fetchImpl }), "연결 주소");
  assert(!invalidRegion.requests.some(({ url }) => url.pathname.endsWith("/conversations")));
});

agentTest("② 연결: 홈페이지의 설정을 불러오지 못하면 실행 상태를 안내", async () => {
  const requests = [];
  await rejects(() => analyzeDrawingWithStudio(testPdf(), {
    fetchImpl: async (target) => {
      requests.push(String(target));
      throw new TypeError("연결 실패");
    },
  }), "홈페이지가 실행 중인지 확인하고 다시 열어 주세요");
  assert(requests.length === 1 && requests[0] === "./agent-connection.local.json");

  const controller = new AbortController();
  controller.abort();
  await rejects(() => analyzeDrawingWithStudio(testPdf(), {
    signal: controller.signal,
    fetchImpl: async (_, options) => {
      assert(options.signal.aborted);
      throw new DOMException("중단", "AbortError");
    },
  }), "기다리기를 중단했어요");
});

agentTest("② 연결: 토큰·파일 전송 실패를 알리고 응답을 기다리지 않음", async () => {
  const unavailable = studioMock({ tokenStatus: 503 });
  await rejects(() => analyzeDrawingWithStudio(testPdf(), { fetchImpl: unavailable.fetchImpl }), "HTTP 503");
  assert(!unavailable.requests.some(({ url }) => url.pathname.endsWith("/upload")));
  const rejected = studioMock({ uploadStatus: 413 });
  await rejects(() => analyzeDrawingWithStudio(testPdf(), { fetchImpl: rejected.fetchImpl }), "PDF 전송에 실패");
  assert(!rejected.requests.some(({ url }) => url.pathname.endsWith("/activities")));
});

agentTest("② 연결: 기다리기 중단과 시간 초과를 구분해 알림", async () => {
  const controller = new AbortController();
  const cancelled = studioMock();
  await rejects(() => analyzeDrawingWithStudio(testPdf(), {
    fetchImpl: cancelled.fetchImpl,
    signal: controller.signal,
    onProgress: (message) => { if (message.includes("②가 도면을 분석")) controller.abort(); },
    pollIntervalMs: 1,
  }), "이미 보냈다면 분석은 계속될 수 있어요");
  assert(cancelled.requests.some(({ url }) => url.pathname.endsWith("/upload")));
  const timedOut = studioMock();
  await rejects(() => analyzeDrawingWithStudio(testPdf(), {
    fetchImpl: timedOut.fetchImpl, pollIntervalMs: 5, timeoutMs: 100,
  }), "시간이 초과");
});

agentTest("화면: ② 자동 분석 결과를 붙여 넣지 않고 표시", async () => {
  if (!app) await openApp();
  await selectFile("simple.pdf");
  const response = `총 분석\n- **파일 읽기:** 가상 PDF를 읽었어요.\n- **확인 필요:** 직접 비교해 주세요.\n\n\`\`\`json\n${await agentFixture()}\n\`\`\``;
  const mock = studioMock({ activityPages: [{ activities: [
    { id: "answer-1", type: "message", replyToId: "sent-1", text: response },
    { type: "event", name: "turn.complete", replyToId: "sent-1" },
  ] }] });
  const originalFetch = frame.contentWindow.fetch;
  frame.contentWindow.fetch = mock.fetchImpl;
  try {
    const button = app.querySelector("#agent-start-button");
    button.click();
    assert(button.disabled && !app.querySelector("#cancel-agent").hidden);
    await waitFor(() => !button.disabled, "② 자동 분석이 끝나지 않았어요.");
    assert(!app.querySelector("#review-screen").hidden, app.querySelector("#read-error").textContent);
    assert(app.querySelector("#agent-status").textContent === "부분 완료");
    assert(app.querySelector("#selected-file-name").textContent.includes("simple.pdf"));
    const summary = app.querySelector("#agent-summary");
    assert(summary.querySelectorAll("li").length === 2);
    assert(summary.querySelector("strong").textContent === "파일 읽기:");
    assert(!summary.textContent.includes("**"));
    assert(!app.querySelector("#agent-manual").open);
    assert(mock.requests.some(({ url }) => url.pathname.endsWith("/upload")));
  } finally {
    frame.contentWindow.fetch = originalFetch;
    if (!app.querySelector("#review-screen").hidden) app.querySelector("#back-button").click();
  }
});

agentTest("화면: ② 자동 연결 실패 시 오류를 알리고 업로드 화면 유지", async () => {
  if (!app) await openApp();
  await selectFile("simple.pdf");
  const mock = studioMock({ configStatus: 503 });
  const originalFetch = frame.contentWindow.fetch;
  frame.contentWindow.fetch = mock.fetchImpl;
  try {
    const button = app.querySelector("#agent-start-button");
    button.click();
    await waitFor(() => !button.disabled, "② 연결 실패 처리가 끝나지 않았어요.");
    assert(app.querySelector("#review-screen").hidden);
    assert(app.querySelector("#read-error").textContent.includes("HTTP 503"));
    assert(app.querySelector("#cancel-agent").hidden);
  } finally {
    frame.contentWindow.fetch = originalFetch;
  }
});

agentTest("화면: 홈페이지가 꺼져 연결 설정을 못 읽으면 실행 상태를 안내", async () => {
  if (!app) await openApp();
  await selectFile("simple.pdf");
  const originalFetch = frame.contentWindow.fetch;
  frame.contentWindow.fetch = async () => { throw new TypeError("연결 실패"); };
  try {
    const button = app.querySelector("#agent-start-button");
    button.click();
    await waitFor(() => !button.disabled, "② 연결 실패 처리가 끝나지 않았어요.");
    assert(app.querySelector("#review-screen").hidden);
    assert(app.querySelector("#read-error").textContent.includes("홈페이지가 실행 중인지 확인"));
    assert(app.querySelector("#cancel-agent").hidden);
  } finally {
    frame.contentWindow.fetch = originalFetch;
  }
});

agentTest("저장: 결과 저장·같은 도면 찾기·덮어쓰기·20개 제한·손상 자료 무시", async () => {
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  const history = createAnalysisHistory({ storage, key: "k" });
  assert(history.list().length === 0);
  const first = history.save({ fileName: "가.pdf", fingerprint: "aaa", response: "응답1" });
  assert(first && history.find("aaa").response === "응답1" && history.get(first.id).fileName === "가.pdf");
  history.save({ fileName: "가-새이름.pdf", fingerprint: "aaa", response: "응답2" });
  assert(history.list().length === 1 && history.find("aaa").response === "응답2", "같은 도면은 최신 결과로 바꿔야 해요.");
  assert(history.find(null) === null && history.find("없음") === null);
  for (let index = 0; index < 25; index += 1) history.save({ fileName: `${index}.pdf`, fingerprint: `f${index}`, response: "r" });
  assert(history.list().length === 20 && history.list()[0].fileName === "24.pdf");
  history.remove(history.list()[0].id);
  assert(history.list().length === 19 && !history.find("f24"));
  data.set("k", "{손상된 자료");
  assert(history.list().length === 0);
  data.set("k", JSON.stringify([{ id: 1 }, { id: "x", fileName: "a", response: "r", savedAt: "t", fingerprint: null }]));
  assert(history.list().length === 1);
  history.clear();
  assert(!data.has("k"));

  const full = createAnalysisHistory({ storage: { ...storage, setItem: () => { throw new Error("가득 참"); } }, key: "k" });
  assert(full.save({ fileName: "a.pdf", fingerprint: "b", response: "r" }) === null, "저장 실패를 알려야 해요.");
  assert(createAnalysisHistory({ storage: null }).save({ fileName: "a", fingerprint: null, response: "r" }) === null);

  const pdf = await fixture("simple.pdf");
  const same = await fileFingerprint(new File([pdf], "a.pdf"));
  assert(same && same === await fileFingerprint(new File([pdf], "다른이름.pdf")), "이름이 달라도 같은 도면은 같게 구분해야 해요.");
  assert(same !== await fileFingerprint(new File(["다른 내용"], "a.pdf")));
});

agentTest("화면: 분석 결과를 저장하고 처음으로 가도 다시 기다리지 않고 열기", async () => {
  if (!app) await openApp();
  if (!app.querySelector("#review-screen").hidden) app.querySelector("#back-button").click();
  frame.contentWindow.localStorage.removeItem(TEST_HISTORY_KEY);
  frame.contentWindow.location.reload();
  await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  app = frame.contentDocument;
  assert(app.querySelector("#history-panel").hidden, "저장된 결과가 없으면 목록을 숨겨야 해요.");

  await selectFile("simple.pdf");
  const response = `총 분석\n- 저장 시험\n\n\`\`\`json\n${await agentFixture()}\n\`\`\``;
  const mock = studioMock({ activityPages: [{ activities: [
    { id: "answer-1", type: "message", replyToId: "sent-1", text: response },
    { type: "event", name: "turn.complete", replyToId: "sent-1" },
  ] }] });
  const originalFetch = frame.contentWindow.fetch;
  frame.contentWindow.fetch = mock.fetchImpl;
  try {
    const button = app.querySelector("#agent-start-button");
    button.click();
    await waitFor(() => !button.disabled, "② 자동 분석이 끝나지 않았어요.");
    assert(!app.querySelector("#review-screen").hidden, app.querySelector("#read-error").textContent);
    assert(app.querySelector("#agent-result-progress").textContent.includes("저장했어요"));
  } finally {
    frame.contentWindow.fetch = originalFetch;
  }
  const stored = JSON.parse(frame.contentWindow.localStorage.getItem(TEST_HISTORY_KEY));
  assert(stored.length === 1 && stored[0].fileName === "simple.pdf" && stored[0].fingerprint);

  app.querySelector("#back-button").click();
  assert(!app.querySelector("#history-panel").hidden);
  const rows = app.querySelectorAll("#history-list li");
  assert(rows.length === 1 && rows[0].textContent.includes("simple.pdf"));
  await waitFor(() => !app.querySelector("#saved-match").hidden, "같은 도면의 저장 결과를 알려야 해요.");

  const requestsBefore = mock.requests.length;
  frame.contentWindow.fetch = () => { throw new Error("저장된 결과를 열 때 다시 보내면 안 돼요."); };
  try {
    app.querySelector("#open-saved-match").click();
    assert(!app.querySelector("#review-screen").hidden, app.querySelector("#read-error").textContent);
    assert(app.querySelector("#agent-summary").textContent.includes("저장 시험"));
    assert(app.querySelector("#agent-result-progress").textContent.includes("다시 분석하지 않고"));
    app.querySelector("#back-button").click();
    rows[0].querySelector(".select-button").click();
    assert(!app.querySelector("#review-screen").hidden && app.querySelector("#agent-status").textContent === "부분 완료");
    assert(app.querySelector("#selected-file-name").textContent.includes("simple.pdf"));
    app.querySelector("#back-button").click();
  } finally {
    frame.contentWindow.fetch = originalFetch;
  }
  assert(mock.requests.length === requestsBefore);

  await selectFile("simple.dxf");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(app.querySelector("#saved-match").hidden, "다른 도면에는 저장 결과를 안내하면 안 돼요.");

  frame.contentWindow.localStorage.setItem(TEST_HISTORY_KEY, JSON.stringify([
    { ...stored[0], response: "읽을 수 없는 결과" },
  ]));
  app.querySelector("#history-list li .select-button").click();
  assert(app.querySelector("#review-screen").hidden);
  assert(app.querySelector("#read-error").textContent.includes("읽을 수 없어"));
  assert(app.querySelector("#history-panel").hidden && !frame.contentWindow.localStorage.getItem(TEST_HISTORY_KEY));
});

agentTest("화면: 저장된 결과 삭제와 파일 이름의 HTML 미실행", async () => {
  if (!app) await openApp();
  const fingerprint = "f".repeat(64);
  frame.contentWindow.localStorage.setItem(TEST_HISTORY_KEY, JSON.stringify([
    { id: "a", fileName: "<img src=x onerror=alert(1)>.pdf", fingerprint, response: "r", savedAt: new Date().toISOString() },
    { id: "b", fileName: "둘째.pdf", fingerprint: null, response: "r", savedAt: new Date().toISOString() },
  ]));
  frame.contentWindow.location.reload();
  await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  app = frame.contentDocument;
  assert(app.querySelectorAll("#history-list li").length === 2);
  assert(!app.querySelector("#history-list img") && app.querySelector("#history-list").textContent.includes("<img"));
  app.querySelector("#history-list li .remove-button").click();
  assert(app.querySelectorAll("#history-list li").length === 1);
  frame.contentWindow.confirm = () => false;
  app.querySelector("#clear-history").click();
  assert(app.querySelectorAll("#history-list li").length === 1, "확인을 취소하면 지우면 안 돼요.");
  frame.contentWindow.confirm = () => true;
  app.querySelector("#clear-history").click();
  assert(app.querySelector("#history-panel").hidden && !frame.contentWindow.localStorage.getItem(TEST_HISTORY_KEY));
});

agentTest("참고 예제: 확인 완료만 모으고 파일 이름·좌표는 빼기", async () => {
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  const history = createAnalysisHistory({ storage, key: "k" });
  const response = `총 분석\n- 비밀 요약\n\n\`\`\`json\n${await agentFixture()}\n\`\`\``;
  const checked = history.save({ fileName: "기밀-부품명.pdf", fingerprint: "a", response });
  history.save({ fileName: "미확인.pdf", fingerprint: "b", response });
  history.save({ fileName: "손상.pdf", fingerprint: "c", response: "읽을 수 없음" });
  assert(checked.verified === false, "새 결과는 확인 전 상태여야 해요.");
  assert(history.setVerified(checked.id, true) && history.get(checked.id).verified === true);
  assert(history.setVerified("없음", true) === false);
  history.setVerified(history.find("c").id, true);

  const result = buildReferenceExamples(history.list());
  assert(result.count === 1, `확인 완료이면서 읽을 수 있는 결과만 넣어야 해요: ${result.count}`);
  assert(result.text.includes("참고 예제 1") && result.text.includes("\"Ø20h7\"") && result.text.includes("연결 상태 연결됨"));
  assert(result.text.includes("값·원문·형상을 새 도면 결과에 옮기지 않습니다"));
  assert(!/기밀-부품명|미확인|비밀 요약|bbox|예시 좌표계/.test(result.text), "파일 이름·요약·좌표는 넣으면 안 돼요.");
  assert(buildReferenceExamples([]).count === 0);

  history.save({ fileName: "다시분석.pdf", fingerprint: "a", response });
  assert(history.find("a").verified === false, "다시 분석한 결과는 다시 확인해야 해요.");
});

agentTest("화면: 확인 완료 체크와 참고 예제 파일 내려받기", async () => {
  if (!app) await openApp();
  if (!app.querySelector("#review-screen").hidden) app.querySelector("#back-button").click();
  const response = `총 분석\n- 화면 시험\n\n\`\`\`json\n${await agentFixture()}\n\`\`\``;
  frame.contentWindow.localStorage.setItem(TEST_HISTORY_KEY, JSON.stringify([
    { id: "a", fileName: "첫째.pdf", fingerprint: null, response, savedAt: new Date().toISOString(), verified: false },
  ]));
  frame.contentWindow.location.reload();
  await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  app = frame.contentDocument;
  const download = app.querySelector("#download-references");
  assert(download.disabled && download.textContent.includes("0개"), "확인 완료가 없으면 내려받을 수 없어야 해요.");
  const box = app.querySelector("#history-list input[type=checkbox]");
  box.click();
  assert(!download.disabled && download.textContent.includes("1개"));
  assert(JSON.parse(frame.contentWindow.localStorage.getItem(TEST_HISTORY_KEY))[0].verified === true);

  const win = frame.contentWindow;
  const originalCreate = win.URL.createObjectURL;
  const originalClick = win.HTMLAnchorElement.prototype.click;
  let blob = null;
  let fileName = "";
  win.URL.createObjectURL = (value) => { blob = value; return "blob:test"; };
  win.HTMLAnchorElement.prototype.click = function click() { fileName = this.download; };
  try {
    download.click();
  } finally {
    win.URL.createObjectURL = originalCreate;
    win.HTMLAnchorElement.prototype.click = originalClick;
  }
  assert(blob && fileName === "blueprint-reading-reference-examples.txt");
  const text = await blob.text();
  assert(text.includes("참고 예제 1") && !text.includes("첫째.pdf"));
  assert(app.querySelector("#reference-status").textContent.includes("1개"));

  box.click();
  assert(download.disabled && download.textContent.includes("0개"));
  frame.contentWindow.localStorage.removeItem(TEST_HISTORY_KEY);
  frame.contentWindow.location.reload();
  await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  app = frame.contentDocument;
});

agentTest("화면: 목록형 요약에 섞인 HTML은 실행하지 않음", async () => {
  if (!app) await openApp();
  app.querySelector("#agent-result-only").click();
  const response = `총 분석\n- **<img src=x onerror=alert(1)>:** <script>alert(1)</script>\n\n\`\`\`json\n${await agentFixture()}\n\`\`\``;
  await showAgentResult(response);
  const summary = app.querySelector("#agent-summary");
  assert(!summary.querySelector("img, script, svg"));
  assert(summary.textContent.includes("<img") && summary.textContent.includes("<script>"));
  app.querySelector("#back-button").click();
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
localStorage.removeItem(TEST_HISTORY_KEY);
window.testResults.done = true;
document.querySelector("#status").textContent = `${window.testResults.passed}개 통과, ${window.testResults.failed}개 실패`;
