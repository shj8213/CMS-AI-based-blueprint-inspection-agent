// PDF 코드 읽기 자료(② 형식 1.1)에서 도면 안의 숫자끼리 서로 맞는지 코드로 바로 점검해요.
// 결과는 ③ 검토 결과(2.0)와 같은 모양이라 같은 화면·동그라미 표시를 그대로 써요.
// 규칙은 도면 종류와 상관없이 쓸 수 있는 일반 규칙만 두고, 연결이 확실하지 않으면 '확인 필요'로 남겨요.

export const CODE_REVIEW_BASIS = "홈페이지 코드 점검(도면 안 숫자끼리 비교, 네트워크 사용 안 함)";
export const CODE_FINDING_PREFIX = "C";

const NUMBER = /^\d+(?:\.\d+)?$/;
const DIAMETER_FIT = /[⌀Ø∅φ]\s*(\d+(?:\.\d+)?)\s*([a-hj-zA-HJ-Z]{1,2}\d{1,2})\b/g;
const KEYWAY_SIZE = /키\s*홈[^\d×]*?(\d+(?:\.\d+)?)\s*[×xX*]\s*\d+(?:\.\d+)?/g;
const KEYWAY_WIDTH = /키\s*홈\s*폭\s*(\d+(?:\.\d+)?)/g;
const SECTION_LABEL = /(?:^|[^A-Z])([A-Z])\s*-\s*\1(?![A-Z])/g;

const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const round = (value) => Math.round(value * 1000) / 1000;
const format = (value) => String(round(value));

function boxOf(element) {
  const box = element.location?.bbox;
  return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) ? box : null;
}

function readTexts(elements) {
  return elements
    .filter((element) => typeof element.raw_text === "string" && element.raw_text.trim() && boxOf(element))
    .map((element) => {
      const [x0, y0, x1, y1] = boxOf(element);
      return { id: element.id, page: element.page_number, text: element.raw_text.trim(), x0, y0, x1, y1, height: Math.max(y1 - y0, 1) };
    });
}

function readHorizontalLines(elements) {
  return elements
    .filter((element) => element.category === "선" && boxOf(element))
    .map((element) => {
      const [x0, y0, x1, y1] = boxOf(element);
      return { page: element.page_number, x0, x1, y: (y0 + y1) / 2, flat: y1 - y0 < 0.5, length: x1 - x0 };
    })
    .filter((line) => line.flat && line.length > 1);
}

// 같은 줄에서 가까이 붙은 글자 조각("⌀", "28", "k6")을 한 문장으로 이어요.
function joinRows(texts) {
  const rows = [];
  const sorted = [...texts].sort((a, b) => a.page - b.page || a.x0 - b.x0);
  for (const piece of sorted) {
    const center = (piece.y0 + piece.y1) / 2;
    const row = rows.find((candidate) => candidate.page === piece.page
      && near(candidate.center, center, Math.min(candidate.height, piece.height) * 0.5)
      && piece.x0 - candidate.x1 <= Math.max(candidate.height, piece.height) * 1.5
      && piece.x0 >= candidate.x0);
    if (row) {
      row.text += `${piece.x0 - row.x1 > piece.height * 0.15 ? " " : ""}${piece.text}`;
      row.x1 = Math.max(row.x1, piece.x1);
      row.pieces.push(piece);
    } else {
      rows.push({ page: piece.page, text: piece.text, x0: piece.x0, x1: piece.x1, center, height: piece.height, pieces: [piece] });
    }
  }
  return rows;
}

// 숫자 글자 바로 아래에 있는 가로 치수선을 찾아 "가로 치수"로 묶어요.
function readHorizontalDimensions(texts, lines) {
  const dimensions = [];
  for (const text of texts) {
    if (!NUMBER.test(text.text)) continue;
    const left = texts.find((other) => other.page === text.page && /^[⌀Ø∅φR]$/.test(other.text)
      && near(other.x1, text.x0, text.height) && near(other.y1, text.y1, text.height * 0.5));
    if (left) continue;
    const middle = (text.x0 + text.x1) / 2;
    const candidates = lines.filter((line) => line.page === text.page
      && line.x0 <= middle && middle <= line.x1
      && line.y - text.y1 >= -2 && line.y - text.y1 <= text.height * 0.8 + 2);
    if (!candidates.length) continue;
    candidates.sort((a, b) => (a.y - b.y) || (a.length - b.length));
    const line = candidates.filter((candidate) => near(candidate.y, candidates[0].y, 0.5))
      .sort((a, b) => a.length - b.length)[0];
    dimensions.push({ text, value: Number(text.text), page: text.page, x0: line.x0, x1: line.x1, y: line.y });
  }
  return dimensions;
}

// 전체 치수선의 양 끝과 정확히 이어지는 다른 줄의 치수들을 찾아요.
function findChain(total, dimensions) {
  const tolerance = Math.max(1.5, (total.x1 - total.x0) * 0.004);
  const rows = new Map();
  for (const dimension of dimensions) {
    if (dimension === total || dimension.page !== total.page || near(dimension.y, total.y, 1)) continue;
    const key = [...rows.keys()].find((y) => near(y, dimension.y, 1)) ?? dimension.y;
    rows.set(key, [...(rows.get(key) ?? []), dimension]);
  }
  for (const row of rows.values()) {
    const sorted = row.sort((a, b) => a.x0 - b.x0);
    let index = sorted.findIndex((dimension) => near(dimension.x0, total.x0, tolerance));
    if (index < 0) continue;
    const chain = [sorted[index]];
    while (!near(chain.at(-1).x1, total.x1, tolerance)) {
      const next = sorted.find((dimension, other) => other > index && near(dimension.x0, chain.at(-1).x1, tolerance));
      if (!next) break;
      chain.push(next);
      index = sorted.indexOf(next);
    }
    if (chain.length >= 2 && near(chain.at(-1).x1, total.x1, tolerance)) return chain;
  }
  return null;
}

function where(text) {
  return `${text.page}페이지 · 좌표 (${Math.round(text.x0)}, ${Math.round(text.y0)}) 부근`;
}

function checkChainSums(texts, lines) {
  const findings = [];
  const passed = [];
  const dimensions = readHorizontalDimensions(texts, lines);
  for (const total of dimensions) {
    const chain = findChain(total, dimensions);
    if (!chain) continue;
    const sum = chain.reduce((acc, dimension) => acc + dimension.value, 0);
    const parts = chain.map((dimension) => dimension.text.text).join(" + ");
    if (near(sum, total.value, 1e-6)) {
      passed.push({
        item: `직렬 치수 합계 ${format(total.value)}`,
        analysis_item_ids: [total.text.id],
        location: where(total.text),
        reason: `${parts} = ${format(sum)}로 전체 치수와 같아요(코드 계산).`,
      });
      continue;
    }
    findings.push({
      classification: "틀림",
      analysis_item_ids: [total.text.id],
      location: where(total.text),
      what: `전체 치수 ${total.text.text} ≠ 직렬 치수 합계 ${format(sum)}`,
      why: `${parts} = ${format(sum)}인데 전체는 ${total.text.text}예요.`,
      evidence: `전체 치수선과 직렬 치수선의 양 끝 좌표가 같아요(x ${Math.round(total.x0)}~${Math.round(total.x1)}).`,
      confidence: "높음",
      confidence_reason: "치수선 끝 좌표가 서로 정확히 이어지고 숫자도 파일에 저장된 값이라 계산 결과가 분명해요.",
      how_to_resolve: "전체 치수나 직렬 치수 중 틀린 쪽을 고쳐 주세요.",
      next_check: "원본 도면에서 전체 치수와 직렬 치수가 같은 두 끝을 잇는지 확인해 주세요.",
    });
  }
  return { findings, passed };
}

function hasLabel(row) {
  return /[:：]/.test(row.text) || /[가-힣]/.test(row.text);
}

function idsAt(row, match) {
  const start = match.index;
  const end = start + match[0].length;
  let cursor = 0;
  const ids = [];
  for (const piece of row.pieces) {
    const pieceStart = row.text.indexOf(piece.text, cursor);
    if (pieceStart < 0) continue;
    const pieceEnd = pieceStart + piece.text.length;
    cursor = pieceEnd;
    if (pieceEnd > start && pieceStart < end) ids.push(piece.id);
  }
  const numberPiece = row.pieces.find((piece) => ids.includes(piece.id) && NUMBER.test(piece.text))
    ?? row.pieces.find((piece) => ids.includes(piece.id) && piece.text.includes(match[1]));
  return numberPiece ? [numberPiece.id] : ids.slice(0, 1);
}

function checkFitSizes(rows) {
  const byFit = new Map();
  for (const row of rows) {
    for (const match of row.text.matchAll(DIAMETER_FIT)) {
      const fit = match[2];
      const item = { size: Number(match[1]), fit, row, note: hasLabel(row), ids: idsAt(row, match) };
      byFit.set(fit, [...(byFit.get(fit) ?? []), item]);
    }
  }
  const findings = [];
  for (const [fit, items] of byFit) {
    const sizes = new Set(items.map((item) => item.size));
    if (sizes.size < 2) continue;
    const notes = items.filter((item) => item.note);
    const marks = items.filter((item) => !item.note);
    const certain = items.length === 2 && notes.length === 1 && marks.length === 1;
    const [first, second] = certain ? [marks[0], notes[0]] : items;
    findings.push({
      classification: certain ? "틀림" : "확인 필요",
      analysis_item_ids: [...first.ids, ...second.ids],
      location: where(first.row.pieces[0]),
      what: certain
        ? `${fit} 지름: 도면 치수 ⌀${format(first.size)} ≠ 주석 ⌀${format(second.size)}`
        : `같은 끼워맞춤 기호 ${fit}가 서로 다른 지름(${[...sizes].map(format).join(", ")})에 쓰였어요.`,
      why: certain
        ? `같은 ${fit} 부위의 지름이 치수와 주석에서 달라요.`
        : "같은 부위인지 코드로는 확정할 수 없어요.",
      evidence: certain
        ? `치수 "${first.row.text}", 주석 "${second.row.text}"`
        : items.map((item) => `"${item.row.text}"`).join(", "),
      confidence: certain ? "중간" : "낮음",
      confidence_reason: certain
        ? "숫자는 파일 값 그대로지만, 주석과 치수가 같은 부위라는 판단은 기호가 한 번씩만 나온다는 점에 기대요."
        : "같은 기호가 여러 번 나와 어느 것끼리 같은 부위인지 알 수 없어요.",
      how_to_resolve: "치수와 주석 중 틀린 쪽을 고쳐 주세요.",
      next_check: `원본 도면에서 ${fit} 주석이 가리키는 부위의 지름을 확인해 주세요.`,
    });
  }
  return findings;
}

function checkKeywayWidths(rows) {
  const items = [];
  for (const row of rows) {
    for (const pattern of [KEYWAY_SIZE, KEYWAY_WIDTH]) {
      for (const match of row.text.matchAll(pattern)) {
        items.push({ width: Number(match[1]), row, ids: idsAt(row, match) });
      }
    }
  }
  const widths = new Set(items.map((item) => item.width));
  if (widths.size < 2) return [];
  const sections = new Set();
  for (const row of rows) for (const match of row.text.matchAll(SECTION_LABEL)) sections.add(match[1]);
  const certain = sections.size <= 1;
  const shown = items.filter((item, index) => items.findIndex((other) => other.width === item.width) === index);
  return [{
    classification: certain ? "틀림" : "확인 필요",
    analysis_item_ids: shown.flatMap((item) => item.ids).slice(0, 3),
    location: where(shown[0].row.pieces[0]),
    what: `키홈 폭: ${shown.map((item) => format(item.width)).join(" ≠ ")}`,
    why: certain
      ? "키홈은 하나인데 폭이 서로 달라요."
      : "서로 다른 키홈일 수도 있어요.",
    evidence: shown.map((item) => `"${item.row.text}"`).join(", "),
    confidence: certain ? "중간" : "낮음",
    confidence_reason: certain
      ? "글자 값은 파일 그대로지만, 같은 키홈이라는 판단은 단면 표시가 하나라는 점에 기대요."
      : "키홈이 여러 개일 수 있어요.",
    how_to_resolve: "폭을 하나로 맞춰 주세요.",
    next_check: "원본 도면의 키홈 단면 치수와 주석을 함께 확인해 주세요.",
  }];
}

// 끼워맞춤 공차가 붙은 지름 구간에 어떤 부품이 들어가는지 도면에 적혀 있지 않으면 사람에게 물어봐요.
// 부품(베어링·오일실 등)을 추측해 판정하지 않고, '질문'으로만 남겨요.
export const PART_QUESTION_CHOICES = ["베어링", "오일실", "기어·풀리", "없음", "모름"];
const PART_WORDS = /베어링|오일\s*실|기어|풀리|커플링|스프로킷|bearing|seal/i;
const MAX_QUESTIONS = 4;

function askFittedParts(rows) {
  const labeledFits = new Set();
  const groups = new Map();
  for (const row of rows) {
    for (const match of row.text.matchAll(DIAMETER_FIT)) {
      if (hasLabel(row) || PART_WORDS.test(row.text)) {
        labeledFits.add(match[2]);
        continue;
      }
      const label = `Ø${format(Number(match[1]))}${match[2]}`;
      const group = groups.get(label) ?? { label, fit: match[2], items: [] };
      group.items.push({ row, ids: idsAt(row, match) });
      groups.set(label, group);
    }
  }
  return [...groups.values()]
    .filter((group) => !labeledFits.has(group.fit))
    .slice(0, MAX_QUESTIONS)
    .map((group) => ({
      classification: "질문",
      issue_type: "연결 불확실",
      analysis_item_ids: group.items.flatMap((item) => item.ids).slice(0, 3),
      location: where(group.items[0].row.pieces[0]),
      what: `${group.label} 구간: 들어가는 부품이 도면에 없어요.`,
      why: "끼워맞춤 공차가 있어 다른 부품이 끼워지는 자리로 보이지만, 무엇인지는 도면만으로 알 수 없어요.",
      evidence: group.items.map((item) => `"${item.row.text}"`).join(", "),
      confidence: "낮음",
      confidence_reason: "부품 종류는 도면 글자에 없어서 코드가 정하지 않았어요.",
      how_to_resolve: "아래 질문에 답하거나, 문제지(조립도)를 함께 보내 ③ 피드백을 받아 주세요.",
      next_check: "문제지(조립도)에서 이 구간에 끼워지는 부품을 확인해 주세요.",
      question: {
        text: `${group.label} 구간에 들어가는 부품은 무엇인가요?`,
        choices: PART_QUESTION_CHOICES,
      },
    }));
}

// ② 형식 1.1 자료(객체 또는 JSON 글)를 받아 ③ 검토 결과(2.0)와 같은 모양의 코드 점검 결과를 돌려줘요.
export function reviewCodeReadAnalysis(analysis) {
  const data = typeof analysis === "string" ? JSON.parse(analysis) : analysis;
  const elements = Array.isArray(data?.elements) ? data.elements : [];
  const texts = readTexts(elements);
  const rows = joinRows(texts);
  const chain = checkChainSums(texts, readHorizontalLines(elements));
  const raw = [...chain.findings, ...checkFitSizes(rows), ...checkKeywayWidths(rows), ...askFittedParts(rows)];
  const findings = raw.map((finding, index) => ({
    id: `${CODE_FINDING_PREFIX}${String(index + 1).padStart(2, "0")}`,
    issue_type: "표기 불일치",
    basis: "도면 안의 다른 표기와 코드로 비교함(기준 자료는 보지 않음)",
    ...finding,
    analysis_item_ids: [...new Set(finding.analysis_item_ids)].slice(0, 3),
  }));
  const wrong = findings.filter((finding) => finding.classification === "틀림").length;
  const questions = findings.filter((finding) => finding.classification === "질문").length;
  const checks = findings.length - wrong - questions;
  const pages = (data?.pages ?? []).map((page) => page.page_number).filter(Number.isInteger);
  return {
    schema_version: "2.0",
    status: "부분 완료",
    review_basis: CODE_REVIEW_BASIS,
    summary: wrong + checks
      ? `코드 점검에서 틀림 ${wrong}건, 확인 필요 ${checks}건을 찾았어요.${questions ? ` 질문 ${questions}개가 있어요.` : ""}`
      : `코드 점검 규칙으로는 서로 어긋나는 숫자를 찾지 못했어요. 문제가 없다는 뜻은 아니에요.${questions ? ` 질문 ${questions}개가 있어요.` : ""}`,
    reviewed_pages: pages,
    unreviewed_pages: [],
    findings,
    not_missing: chain.passed,
    limitations: [
      "코드 점검은 3가지 규칙만 봐요: ① 가로 직렬 치수 합계와 전체 치수, ② 같은 끼워맞춤 기호(예: k6)가 붙은 지름 치수와 주석, ③ 키홈 폭 주석끼리.",
      "세로 치수, 지시선이 가리키는 대상, 설계 의도, 규격(KS) 적합성은 코드로 보지 않아요. 필요하면 ‘피드백 받기’로 ③ 검토를 이어서 받으세요.",
      "같은 부위인지 확실하지 않으면 '확인 필요'(노랑)로 남겼어요. 결과는 사람이 원본 도면과 직접 비교해야 해요.",
      "끼워맞춤 지름 구간에 들어가는 부품이 도면에 없으면 추측하지 않고 '질문'(파랑)으로 물어봐요. 답은 이 화면에만 기록되고 아직 추가 점검에는 쓰지 않아요.",
    ],
    human_review_status: "미확인",
  };
}

// ③ 결과에 코드 점검 결과를 앞에 붙여요. 같은 글자 항목을 가리키는 ③ 지적은 중복이라 빼요.
export function mergeCodeReview(codeReview, studioReview) {
  const studio = typeof studioReview === "string" ? JSON.parse(studioReview) : studioReview;
  if (studio?.schema_version !== "2.0" || !Array.isArray(studio.findings) || !codeReview.findings.length) return studio;
  const codeIds = new Set(codeReview.findings
    .filter((finding) => finding.classification !== "질문")
    .flatMap((finding) => finding.analysis_item_ids));
  const kept = studio.findings.filter((finding) => !(finding.analysis_item_ids ?? []).some((id) => codeIds.has(id)));
  const dropped = studio.findings.length - kept.length;
  return {
    ...studio,
    summary: `${codeReview.summary} ${studio.summary}`,
    findings: [...codeReview.findings, ...kept],
    limitations: [
      ...(Array.isArray(studio.limitations) ? studio.limitations : []),
      `앞쪽 ${CODE_FINDING_PREFIX}로 시작하는 지적은 홈페이지 코드 점검 결과예요.`
        + (dropped ? ` 같은 글자를 가리킨 ③ 지적 ${dropped}건은 중복이라 뺐어요.` : ""),
    ],
  };
}
