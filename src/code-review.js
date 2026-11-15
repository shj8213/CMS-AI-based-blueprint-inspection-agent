// PDF 코드 읽기 자료(② 형식 1.1)에서 도면 안의 숫자끼리 서로 맞는지 코드로 바로 점검해요.
// 결과는 ③ 검토 결과(2.0)와 같은 모양이라 같은 화면·동그라미 표시를 그대로 써요.
// 규칙은 도면 종류와 상관없이 쓸 수 있는 일반 규칙만 두고, 연결이 확실하지 않으면 '확인 필요'로 남겨요.

export const CODE_REVIEW_BASIS = "홈페이지 코드 점검(도면 안 숫자끼리 비교, 네트워크 사용 안 함)";
export const CODE_FINDING_PREFIX = "C";

const NUMBER = /^\d+(?:\.\d+)?$/;
const DIAMETER_FIT = /[⌀Ø∅φ]\s*(\d+(?:\.\d+)?)\s*([a-hj-zA-HJ-Z]{1,2}\d{1,2})\b/g;
const KEYWAY_SIZE = /키\s*홈[^\d×]*?(\d+(?:\.\d+)?)\s*[×xX*]\s*\d+(?:\.\d+)?/g;
const KEYWAY_WIDTH = /키\s*홈\s*폭\s*(\d+(?:\.\d+)?)/g;
const KEYWAY_WIDTH_ONE = /키\s*홈\s*폭\s*(\d+(?:\.\d+)?)/;
const SECTION_LABEL = /(?:^|[^A-Z])([A-Z])\s*-\s*\1(?![A-Z])/g;

const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const round = (value) => Math.round(value * 1000) / 1000;
const format = (value) => String(round(value));

function boxOf(element) {
  const box = element.location?.bbox;
  return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) ? box : null;
}

// 일부 PDF는 띄어쓰기를 보이지 않는 제어 글자(\u0001 등)로 넣어서, 이런 글자는 빈칸으로 보고 빼요.
const cleanText = (text) => text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();

function readTexts(elements) {
  return elements
    .filter((element) => typeof element.raw_text === "string" && cleanText(element.raw_text) && boxOf(element))
    .map((element) => {
      const [x0, y0, x1, y1] = boxOf(element);
      return { id: element.id, page: element.page_number, text: cleanText(element.raw_text), x0, y0, x1, y1, height: Math.max(y1 - y0, 1) };
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
    // 도면 축척으로 각 치수선의 그려진 길이를 재서, 적힌 숫자와 다른 치수가 딱 하나면 그 치수를 범인으로 가리켜요.
    const scale = drawingScale(dimensions);
    const drawnOf = (dimension) => Math.round(((dimension.x1 - dimension.x0) / scale) * 10) / 10;
    const odd = scale
      ? [total, ...chain].filter((dimension) => Math.abs(drawnOf(dimension) - dimension.value) > Math.max(0.5, dimension.value * 0.03))
      : [];
    const culprit = odd.length === 1 ? odd[0] : null;
    const culpritNote = culprit
      ? ` · 그려진 길이로 재면 ${culprit === total ? "전체 치수" : "직렬 치수"} ${culprit.text.text} 부분은 약 ${format(drawnOf(culprit))}(mm)로 그려져 있어요`
      : "";
    findings.push({
      classification: "틀림",
      analysis_item_ids: culprit && culprit !== total ? [culprit.text.id, total.text.id] : [total.text.id],
      location: where((culprit ?? total).text),
      what: `전체 치수 ${total.text.text} ≠ 직렬 치수 합계 ${format(sum)}${culpritNote}`,
      why: `${parts} = ${format(sum)}인데 전체는 ${total.text.text}예요.`,
      evidence: `전체 치수선과 직렬 치수선의 양 끝 좌표가 같아요(x ${Math.round(total.x0)}~${Math.round(total.x1)}).${culprit
        ? ` 치수선 길이 ${format(culprit.x1 - culprit.x0)}pt ÷ 축척 ${format(scale)}pt/mm(가로 치수들로 계산) ≈ ${format(drawnOf(culprit))}`
        : ""}`,
      confidence: "높음",
      confidence_reason: `치수선 끝 좌표가 서로 정확히 이어지고 숫자도 파일에 저장된 값이라 계산 결과가 분명해요.${culprit
        ? " 어느 치수가 틀렸는지는 그려진 길이로 추정한 것이라, 축척을 무시하고 그린 부분이면 다를 수 있어요."
        : ""}`,
      how_to_resolve: culprit
        ? `${culprit.text.text} 치수(그려진 길이 약 ${format(drawnOf(culprit))})부터 확인해 고쳐 주세요.`
        : "전체 치수나 직렬 치수 중 틀린 쪽을 고쳐 주세요.",
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

// ── 키홈 그림 폭 ──────────────────────────────────────────────────
// 가로 치수의 '글자 값 ÷ 선 길이'로 도면 축척을 구하고, N9·P9 키홈 폭 글자 아래 보조선 두 개 사이를 재서 비교해요.
const KEY_WIDTH_TEXT = /^(\d+(?:\.\d+)?)\s*[NP]9$/;

function readVerticalLines(elements) {
  return elements
    .filter((element) => element.category === "선" && boxOf(element))
    .map((element) => {
      const [x0, y0, x1, y1] = boxOf(element);
      return { page: element.page_number, id: element.id, x: (x0 + x1) / 2, y0, y1, narrow: x1 - x0 < 0.5 };
    })
    .filter((line) => line.narrow && line.y1 - line.y0 > 1);
}

function drawingScale(dimensions) {
  const ratios = dimensions.filter((dimension) => dimension.value > 0)
    .map((dimension) => (dimension.x1 - dimension.x0) / dimension.value)
    .sort((a, b) => a - b);
  if (ratios.length < 3) return null;
  // 표 칸 숫자처럼 치수가 아닌 글자도 섞일 수 있어서, 가장 많이 서로 맞는 묶음을 축척으로 써요.
  let best = [];
  for (const ratio of ratios) {
    const group = ratios.filter((other) => Math.abs(other - ratio) <= ratio * 0.02);
    if (group.length > best.length) best = group;
  }
  if (best.length < 3 || best.length < ratios.length / 2) return null;
  return best[Math.floor(best.length / 2)];
}

function checkDrawnKeyWidths(texts, elements, dimensions) {
  const scale = drawingScale(dimensions);
  if (!scale) return { findings: [], passed: [] };
  const verticals = readVerticalLines(elements);
  const findings = [];
  const passed = [];
  for (const text of texts) {
    const match = text.text.match(KEY_WIDTH_TEXT);
    if (!match) continue;
    const written = Number(match[1]);
    const near40 = verticals.filter((line) => line.page === text.page
      && line.y0 >= text.y0 - 2 && line.y0 <= text.y1 + 15
      && line.x > text.x0 - 40 && line.x < text.x1 + 40);
    let pair = null;
    for (const a of near40) {
      for (const b of near40) {
        if (b.x <= a.x + 1 || !near(a.y0, b.y0, 1) || !near(a.y1, b.y1, 1)) continue;
        if (!pair || Math.abs(b.x - a.x - written * scale) < Math.abs(pair[1].x - pair[0].x - written * scale)) pair = [a, b];
      }
    }
    if (!pair) continue;
    const drawn = Math.round(((pair[1].x - pair[0].x) / scale) * 10) / 10;
    if (Math.abs(drawn - written) <= Math.max(0.3, written * 0.05)) {
      passed.push({ item: `키홈 폭 ${text.text}`, location: where(text), reason: `그려진 폭(약 ${format(drawn)})과 같아요.`, analysis_item_ids: [text.id, pair[0].id, pair[1].id] });
      continue;
    }
    findings.push({
      classification: "틀림",
      issue_type: "표기 불일치",
      analysis_item_ids: [text.id, pair[0].id, pair[1].id],
      location: where(text),
      what: `키홈 폭: 글자 ${text.text} ≠ 그려진 폭 약 ${format(drawn)}`,
      why: "같은 치수의 보조선 두 개 사이 거리를 도면 축척으로 재면 적힌 폭과 달라요.",
      evidence: `글자 "${text.text}", 보조선 간격 ${format(pair[1].x - pair[0].x)}pt, 축척 ${format(scale)}pt/mm(가로 치수들로 계산)`,
      confidence: "중간",
      confidence_reason: "N9·P9가 붙은 숫자를 키홈 폭으로, 글자 바로 아래 같은 높이의 세로선 두 개를 그 보조선으로 봤어요. 축척을 무시하고(NS) 그린 부분이면 틀릴 수 있어요.",
      how_to_resolve: "적힌 폭과 그림 중 틀린 쪽을 고쳐 주세요(키 규격에 맞는 값인지도 확인).",
      next_check: "단면도에서 키홈 폭 치수와 그려진 홈 폭을 확인해 주세요.",
    });
  }
  return { findings, passed };
}

// ── 데이텀 ───────────────────────────────────────────────────────
// 네모 칸 안의 대문자 한 글자(예: [A])는 정의된 데이텀, 기하공차 칸의 A-B·A-C나 공차 값 옆 글자는 참조로 봐요.
// 'A-A'처럼 같은 글자 둘은 단면 표시라 빼요. 정의된 데이텀을 하나도 못 찾으면 판단하지 않아요.
const DATUM_TEXT = /^([A-Z])(?:\s*-\s*([A-Z]))?$/;
const TOLERANCE_VALUE = /^[⌀Ø∅φ]?\d*\.\d+$/;

function isBoxed(text, lines) {
  const covers = (line) => line.page === text.page && line.x0 <= text.x0 && line.x1 >= text.x1 && line.length < 40;
  return lines.some((line) => covers(line) && line.y <= text.y0 + 1 && line.y >= text.y0 - 6)
    && lines.some((line) => covers(line) && line.y >= text.y1 - 1 && line.y <= text.y1 + 6);
}

function checkDatums(texts, lines) {
  const values = texts.filter((text) => TOLERANCE_VALUE.test(text.text));
  const besideValue = (text) => values.some((value) => value.page === text.page
    && near((value.y0 + value.y1) / 2, (text.y0 + text.y1) / 2, text.height * 0.5)
    && text.x0 > value.x1 && text.x0 - value.x1 < 80);
  const defined = new Map();
  const references = [];
  for (const text of texts) {
    const match = text.text.match(DATUM_TEXT);
    if (!match) continue;
    if (match[2]) {
      if (match[2] !== match[1]) references.push({ text, letters: [match[1], match[2]] });
    } else if (besideValue(text)) {
      references.push({ text, letters: [match[1]] });
    } else if (isBoxed(text, lines) && !defined.has(match[1])) {
      defined.set(match[1], text);
    }
  }
  if (!defined.size) return { findings: [], passed: [] };
  const findings = [];
  const passed = [];
  const known = [...defined.keys()].sort().join(", ");
  for (const reference of references) {
    const missing = reference.letters.filter((letter) => !defined.has(letter));
    if (!missing.length) {
      passed.push({ item: `기하공차 데이텀 ${reference.text.text}`, location: where(reference.text), reason: `도면에 데이텀 ${reference.letters.join(", ")}가 모두 있어요.`, analysis_item_ids: [reference.text.id] });
      continue;
    }
    findings.push({
      classification: "틀림",
      issue_type: "표기 불일치",
      analysis_item_ids: [reference.text.id],
      location: where(reference.text),
      what: `기하공차가 도면에 없는 데이텀 ${missing.join(", ")}을(를) 참조해요 (${reference.text.text}).`,
      why: `기하공차가 참조하는 데이텀은 도면에 데이텀 기호로 정의돼 있어야 해요. 이 도면에 정의된 데이텀은 ${known}뿐이에요.`,
      evidence: `참조 "${reference.text.text}", 정의된 데이텀 ${[...defined.values()].map((text) => `"${text.text}"`).join(", ")}`,
      confidence: "높음",
      confidence_reason: "네모 칸 안의 대문자를 데이텀으로 읽었어요. 데이텀 기호가 그림(이미지)으로만 들어 있으면 놓칠 수 있어요.",
      how_to_resolve: `데이텀 ${missing.join(", ")}을(를) 도면에 정의하거나, 있는 데이텀(${known})으로 참조를 고쳐 주세요.`,
      next_check: "원본 도면에서 데이텀 기호(삼각형+네모 글자)를 모두 찾아 주세요.",
    });
  }
  return { findings, passed };
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

// ── 문제지 대조 ───────────────────────────────────────────────────
// 문제지 PDF의 '조립 정보' 표(팀이 정한 형식)만 글자로 읽어요. 조립도 그림은 해석하지 않아요.
//   Ø20 k6 : 베어링 6204   /   키홈 폭 6   /   축 전체 길이 118
const SHEET_PART = /[⌀Ø∅φ]\s*(\d+(?:\.\d+)?)\s*([a-hj-zA-HJ-Z]{1,2}\d{1,2})?\s*[:：]\s*(.+)$/;
const SHEET_KEY_DEPTH = /키\s*홈\s*깊이\s*(\d+(?:\.\d+)?)/;
const SHEET_GEOMETRIC = /기하\s*공차/;
const SHEET_TOTAL = /전체\s*길이\s*(\d+(?:\.\d+)?)/;
const DRAWING_KEY_WIDTH = /^(\d+(?:\.\d+)?)\s*[NP]9$/;
const PLAIN_DIAMETER = /[⌀Ø∅φ]\s*(\d+(?:\.\d+)?)/g;

export class ProblemSheetError extends Error {}

export function readProblemSheet(analysis) {
  const data = typeof analysis === "string" ? JSON.parse(analysis) : analysis;
  const rows = joinRows(readTexts(Array.isArray(data?.elements) ? data.elements : []));
  const heading = rows.find((row) => /조립\s*정보/.test(row.text));
  if (!heading) {
    throw new ProblemSheetError("문제지에서 '조립 정보' 표를 찾지 못했어요. 코드 대조는 하지 않고 ③에 보낼 때만 함께 보내요.");
  }
  const parts = [];
  let keywayWidth = null;
  let totalLength = null;
  let keywayDepth = null;
  let geometric = null;
  for (const row of rows) {
    if (row.page !== heading.page || row.center < heading.center) continue;
    const part = row.text.match(SHEET_PART);
    if (part && PART_WORDS.test(part[3])) {
      parts.push({ size: Number(part[1]), fit: part[2] ?? null, part: part[3].trim(), text: row.text });
      continue;
    }
    const width = row.text.match(KEYWAY_WIDTH_ONE);
    if (width) keywayWidth = Number(width[1]);
    const total = row.text.match(SHEET_TOTAL);
    if (total) totalLength = Number(total[1]);
    const depth = row.text.match(SHEET_KEY_DEPTH);
    if (depth) keywayDepth = Number(depth[1]);
    if (SHEET_GEOMETRIC.test(row.text)) geometric = row.text;
  }
  if (!parts.length && keywayWidth == null && totalLength == null) {
    throw new ProblemSheetError("'조립 정보' 표에서 대조할 줄(예: Ø20 k6 : 베어링)을 찾지 못했어요.");
  }
  return { fileName: data?.source?.file_name ?? "", parts, keywayWidth, totalLength, keywayDepth, geometric };
}

const SHEET_BASIS = "문제지 '조립 정보' 표와 도면 글자를 코드로 비교함";

function compareWithSheet(sheet, texts, rows, dimensions, findings) {
  const extra = [];
  const passed = [];
  const fitted = rows.flatMap((row) => [...row.text.matchAll(DIAMETER_FIT)].map((match) => (
    { size: Number(match[1]), fit: match[2], row, ids: idsAt(row, match) })));
  const answered = new Set();
  for (const item of sheet.parts) {
    const label = `Ø${format(item.size)}${item.fit ?? ""}`;
    const same = fitted.filter((entry) => entry.size === item.size);
    const plain = rows.filter((row) => [...row.text.matchAll(PLAIN_DIAMETER)].some((match) => Number(match[1]) === item.size));
    if (item.fit && same.length && !same.some((entry) => entry.fit === item.fit)) {
      extra.push({
        classification: "틀림",
        issue_type: "표기 불일치",
        basis: SHEET_BASIS,
        analysis_item_ids: same.flatMap((entry) => entry.ids),
        location: where(same[0].row.pieces[0]),
        what: `Ø${format(item.size)} 끼워맞춤: 문제지 ${item.fit} ≠ 도면 ${[...new Set(same.map((entry) => entry.fit))].join(", ")}`,
        why: `문제지 조립 정보에는 Ø${format(item.size)} 구간이 ${item.fit}(${item.part})로 적혀 있어요.`,
        evidence: `문제지 "${item.text}", 도면 ${same.map((entry) => `"${entry.row.text}"`).join(", ")}`,
        confidence: "중간",
        confidence_reason: "지름 숫자가 같은 구간끼리 비교했어요. 같은 지름 구간이 여러 개면 다른 구간일 수도 있어요.",
        how_to_resolve: "문제지에 맞게 끼워맞춤 기호를 고쳐 주세요.",
        next_check: "문제지 조립도에서 이 구간의 부품을 확인해 주세요.",
      });
      // 부품은 문제지로 알았으니 같은 구간 질문은 다시 하지 않아요.
      for (const entry of same) answered.add(`${format(entry.size)}${entry.fit}`);
    } else if (same.length || plain.length) {
      if (item.fit && !same.length) {
        extra.push({
          classification: "확인 필요",
          issue_type: "누락",
          basis: SHEET_BASIS,
          analysis_item_ids: plain.flatMap((row) => row.pieces.map((piece) => piece.id)).slice(0, 3),
          location: where(plain[0].pieces[0]),
          what: `Ø${format(item.size)} 구간: 문제지에는 ${item.fit}(${item.part})인데 도면에 끼워맞춤 기호가 없어요.`,
          why: "부품이 끼워지는 자리는 보통 끼워맞춤 공차가 필요해요.",
          evidence: `문제지 "${item.text}", 도면 ${plain.map((row) => `"${row.text}"`).join(", ")}`,
          confidence: "낮음",
          confidence_reason: "같은 지름 숫자를 찾았지만 같은 구간인지는 코드로 확정하지 못해요.",
          how_to_resolve: "필요하면 끼워맞춤 기호를 넣어 주세요.",
          next_check: "도면의 이 지름 치수가 문제지의 부품 자리인지 확인해 주세요.",
        });
      } else {
        passed.push({ item: `${label} 구간 부품`, location: where((same[0]?.row ?? plain[0]).pieces[0]), reason: `문제지에서 확인: ${item.part}`, analysis_item_ids: [...same.flatMap((entry) => entry.ids), ...plain.flatMap((row) => row.pieces.map((piece) => piece.id))].slice(0, 3) });
      }
      for (const entry of same) answered.add(`${format(entry.size)}${entry.fit}`);
    } else {
      extra.push({
        classification: "확인 필요",
        issue_type: "누락",
        basis: SHEET_BASIS,
        analysis_item_ids: [],
        location: "도면 전체",
        what: `문제지의 ${label} 구간(${item.part}) 지름 치수를 도면에서 찾지 못했어요.`,
        why: "문제지에 있는 부품 자리가 도면에 빠졌을 수 있어요.",
        evidence: `문제지 "${item.text}"`,
        confidence: "낮음",
        confidence_reason: "글자로만 찾았어요. 치수가 그림·다른 표기로 들어갔을 수 있어요.",
        how_to_resolve: "빠졌다면 지름 치수를 넣어 주세요.",
        next_check: "원본 도면에서 이 지름 치수를 찾아 주세요.",
      });
    }
  }

  if (sheet.keywayWidth != null) {
    const widths = [];
    for (const row of rows) {
      for (const pattern of [KEYWAY_SIZE, KEYWAY_WIDTH]) {
        for (const match of row.text.matchAll(pattern)) widths.push({ width: Number(match[1]), row, ids: idsAt(row, match) });
      }
    }
    for (const text of texts) {
      const match = text.text.match(DRAWING_KEY_WIDTH);
      if (match) widths.push({ width: Number(match[1]), row: { text: text.text, pieces: [text] }, ids: [text.id] });
    }
    const wrong = widths.filter((entry) => entry.width !== sheet.keywayWidth);
    const note = `문제지 조립 정보의 키홈 폭 ${format(sheet.keywayWidth)}과도 달라요.`;
    const existing = wrong.length && findings.find((finding) => wrong.every((entry) => entry.ids.some((id) => finding.analysis_item_ids.includes(id))));
    if (existing) {
      existing.evidence = `${existing.evidence} / ${note}`;
      existing.why = `${existing.why} ${note}`;
      existing.confidence = "높음";
      existing.confidence_reason = `${existing.confidence_reason} 문제지와 그림 두 근거가 같은 결론이에요.`;
    } else if (wrong.length) {
      extra.push({
        classification: "틀림",
        issue_type: "표기 불일치",
        basis: SHEET_BASIS,
        analysis_item_ids: wrong.flatMap((entry) => entry.ids),
        location: where(wrong[0].row.pieces[0]),
        what: `키홈 폭: 문제지 ${format(sheet.keywayWidth)} ≠ 도면 ${wrong.map((entry) => entry.row.text).join(", ")}`,
        why: "문제지 조립 정보의 키홈 폭과 도면 표기가 달라요.",
        evidence: `문제지 "키홈 폭 ${format(sheet.keywayWidth)}", 도면 ${wrong.map((entry) => `"${entry.row.text}"`).join(", ")}`,
        confidence: "중간",
        confidence_reason: "'키홈' 글자나 N9·P9가 붙은 숫자를 키홈 폭으로 봤어요.",
        how_to_resolve: "문제지에 맞게 키홈 폭을 고쳐 주세요.",
        next_check: "단면도의 키홈 폭 치수를 확인해 주세요.",
      });
    } else if (widths.length) {
      passed.push({ item: "키홈 폭", location: where(widths[0].row.pieces[0]), reason: `문제지에서 확인: 키홈 폭 ${format(sheet.keywayWidth)}과 같아요.`, analysis_item_ids: widths.flatMap((entry) => entry.ids).slice(0, 3) });
    }
  }

  if (sheet.totalLength != null) {
    const totals = dimensions.filter((dimension) => findChain(dimension, dimensions));
    const longest = totals.sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0))[0];
    // 직렬 치수로 이어진 전체 치수를 못 찾으면 비교하지 않아요.
    if (longest && longest.value !== sheet.totalLength) {
      const note = `문제지 전체 길이 ${format(sheet.totalLength)}와도 달라요.`;
      const existing = findings.find((finding) => finding.analysis_item_ids.includes(longest.text.id));
      if (existing) {
        existing.evidence = `${existing.evidence} / ${note}`;
        existing.why = `${existing.why} ${note}`;
      } else {
        extra.push({
          classification: "틀림",
          issue_type: "표기 불일치",
          basis: SHEET_BASIS,
          analysis_item_ids: [longest.text.id],
          location: where(longest.text),
          what: `축 전체 길이: 문제지 ${format(sheet.totalLength)} ≠ 도면 ${format(longest.value)}`,
          why: "직렬 치수로 이어진 가장 긴 가로 치수(전체 길이)가 문제지와 달라요.",
          evidence: `문제지 "축 전체 길이 ${format(sheet.totalLength)}", 도면 "${longest.text.text}"`,
          confidence: "중간",
          confidence_reason: "직렬 치수로 이어진 가장 긴 가로 치수를 축 전체 길이로 봤어요.",
          how_to_resolve: "문제지에 맞게 전체 길이를 고쳐 주세요.",
          next_check: "전체 길이 치수를 확인해 주세요.",
        });
      }
    } else if (longest) {
      passed.push({ item: "축 전체 길이", location: where(longest.text), reason: `문제지에서 확인: ${format(sheet.totalLength)}과 같아요.`, analysis_item_ids: [longest.text.id] });
    }
  }
  const features = checkSheetFeatures(sheet, texts, dimensions);
  extra.push(...features.extra);
  passed.push(...features.passed);
  return { extra, passed, answered, roughness: checkSheetRoughness(sheet, texts, rows, dimensions) };
}

// ── 문제지의 키홈 깊이와 기하공차 ────────────────────────────────
// 키홈 깊이: N9·P9 키홈 폭 글자 가까이(약 25mm 안)의 숫자만 있는 글자를 깊이로 봐요.
// 기하공차: 문제지가 기하공차를 요구하는데 도면에 공차 값(예: 0.011)이 하나도 없으면 알려요.
const SHEET_TOLERANCE_VALUE = /^0?\.\d{1,3}$/;
// 거칠기(Ra) 표준 값은 기하공차 값이 아니므로 제외해요.
const ROUGHNESS_STANDARD_VALUES = new Set([0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.3, 12.5]);

function checkSheetFeatures(sheet, texts, dimensions) {
  const result = { extra: [], passed: [] };
  const scale = drawingScale(dimensions);
  const keyText = texts.find((text) => KEY_WIDTH_TEXT.test(text.text));
  if (sheet.keywayDepth != null && keyText && scale) {
    const width = Number(keyText.text.match(KEY_WIDTH_TEXT)[1]);
    const reach = 25 * scale;
    const centre = (text) => [(text.x0 + text.x1) / 2, (text.y0 + text.y1) / 2];
    const [kx, ky] = centre(keyText);
    const near = texts.filter((text) => text !== keyText && text.page === keyText.page && NUMBER.test(text.text)
      && Number(text.text) !== width && Math.hypot(centre(text)[0] - kx, centre(text)[1] - ky) <= reach);
    const same = near.find((text) => Number(text.text) === sheet.keywayDepth);
    if (same) {
      result.passed.push({
        item: `키홈 깊이 ${format(sheet.keywayDepth)}`,
        analysis_item_ids: [same.id, keyText.id],
        location: where(same),
        reason: `문제지에서 확인: 키홈 깊이 ${format(sheet.keywayDepth)}이 단면 키홈 근처에 같은 값으로 있어요.`,
      });
    } else {
      const other = near[0];
      result.extra.push({
        classification: other ? "틀림" : "확인 필요",
        issue_type: other ? "표기 불일치" : "누락",
        basis: SHEET_BASIS,
        analysis_item_ids: [other?.id ?? keyText.id, keyText.id],
        location: where(other ?? keyText),
        what: other
          ? `키홈 깊이: 문제지 ${format(sheet.keywayDepth)} ≠ 도면 ${other.text}`
          : `키홈 깊이: 문제지의 ${format(sheet.keywayDepth)}을 단면 키홈 근처에서 찾지 못했어요.`,
        why: "문제지 조립 정보의 키홈 깊이와 단면의 깊이 치수가 달라요.",
        evidence: `문제지 "키홈 깊이 ${format(sheet.keywayDepth)}", 도면 ${other ? `"${other.text}"` : "근처 숫자 없음"}(키홈 폭 ${keyText.text} 글자 주변 약 25mm 안)`,
        confidence: other ? "중간" : "낮음",
        confidence_reason: "키홈 폭 글자 가까이의 숫자를 깊이 치수로 봤어요. 다른 숫자가 근처에 있으면 틀릴 수 있어요.",
        how_to_resolve: "문제지에 맞게 키홈 깊이를 고쳐 주세요.",
        next_check: "단면도의 깊이 치수를 확인해 주세요.",
      });
    }
  }
  if (sheet.geometric) {
    const values = texts.filter((text) => SHEET_TOLERANCE_VALUE.test(text.text)
      && !ROUGHNESS_STANDARD_VALUES.has(Number(text.text)));
    if (values.length) {
      result.passed.push({
        item: "기하공차 표기",
        analysis_item_ids: [values[0].id],
        location: where(values[0]),
        reason: `문제지에서 기하공차를 요구했고, 도면에 공차 값 ${values[0].text}이 있어요(코드로 글자만 확인).`,
      });
    } else {
      result.extra.push({
        classification: "확인 필요",
        issue_type: "누락",
        basis: SHEET_BASIS,
        analysis_item_ids: [],
        location: "도면 전체",
        what: "기하공차: 문제지에서 요구했는데 도면에서 공차 값을 찾지 못했어요.",
        why: "문제지 조립 정보에 기하공차가 있는데 도면에 0.01 같은 공차 값 글자가 없어요.",
        evidence: `문제지 "${sheet.geometric}", 도면에 0.0xx 형태의 글자 없음`,
        confidence: "낮음",
        confidence_reason: "공차 값을 글자(0.011 등)로만 찾아요. 그림이나 다른 표기면 놓칠 수 있어요.",
        how_to_resolve: "필요한 기하공차 기호와 값을 넣어 주세요.",
        next_check: "원본 도면에서 기하공차 틀(공차 기호·값·데이텀)이 있는지 확인해 주세요.",
      });
    }
  }
  return result;
}

// ── 문제지 부품 자리의 표면 거칠기 기호 ──────────────────────────
// 문제지에 적힌 부품 자리(지름 구간)마다 w·x·y·z 거칠기 글자가 그 구간 위아래 가까이에 있는지 봐요.
const ROUGHNESS_LETTER = /^[wxyz]$/;

function checkSheetRoughness(sheet, texts, rows, dimensions) {
  const result = { extra: [], passed: [] };
  const scale = drawingScale(dimensions);
  const letters = texts.filter((text) => ROUGHNESS_LETTER.test(text.text));
  // 축척을 모르거나 거칠기를 글자 기호로 쓰지 않은 도면이면 보지 않아요.
  if (!scale || !letters.length) return result;
  const totals = dimensions.filter((dimension) => findChain(dimension, dimensions));
  const longest = totals.sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0))[0];
  const chain = longest ? findChain(longest, dimensions) : null;
  if (!chain) return result;
  const reach = 25 * scale;
  const seen = new Set();
  for (const item of sheet.parts) {
    const pieces = rows.flatMap((row) => [...row.text.matchAll(PLAIN_DIAMETER)]
      .filter((match) => Number(match[1]) === item.size)
      .map((match) => row.pieces.find((piece) => idsAt(row, match).includes(piece.id)) ?? row.pieces[0]));
    for (const piece of pieces) {
      const cx = (piece.x0 + piece.x1) / 2;
      const cy = (piece.y0 + piece.y1) / 2;
      const span = chain.find((dimension) => dimension.text.page === piece.page && dimension.x0 <= cx && cx <= dimension.x1);
      if (!span) continue;
      const key = `${span.x0}:${span.x1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const margin = 2 * scale;
      const found = letters.find((letter) => letter.page === piece.page
        && (letter.x0 + letter.x1) / 2 >= span.x0 - margin && (letter.x0 + letter.x1) / 2 <= span.x1 + margin
        && Math.abs((letter.y0 + letter.y1) / 2 - cy) <= reach);
      const label = `Ø${format(item.size)}${item.fit ?? ""}`;
      if (found) {
        result.passed.push({
          item: `${label} 구간 표면 거칠기`,
          analysis_item_ids: [found.id, piece.id],
          location: where(found),
          reason: `문제지 부품(${item.part}) 자리에 거칠기 기호 ${found.text}가 있어요(코드로 위치 확인).`,
        });
        continue;
      }
      result.extra.push({
        classification: "확인 필요",
        issue_type: "누락",
        basis: SHEET_BASIS,
        analysis_item_ids: [piece.id, span.text.id],
        location: where(piece),
        what: `${label} 구간(${item.part}): 표면 거칠기 기호를 찾지 못했어요.`,
        why: "문제지에서 부품이 끼워지는 자리인데, 이 구간 가까이에 w·x·y·z 거칠기 기호가 없어요.",
        evidence: `문제지 "${item.text}", 도면 "${piece.text}" 구간(가로 치수 ${span.text.text}) 위아래 약 25mm 안에 거칠기 글자 없음`,
        confidence: "중간",
        confidence_reason: "거칠기 기호를 w·x·y·z 한 글자로만 찾아요. 그림 기호만 그렸거나 멀리 떨어져 있으면 놓칠 수 있어요.",
        how_to_resolve: "부품이 끼워지는 면이면 알맞은 표면 거칠기 기호를 넣어 주세요.",
        next_check: "원본 도면에서 이 구간 표면에 거칠기 기호가 있는지 확인해 주세요.",
      });
    }
  }
  return result;
}

// ② 형식 1.1 자료(객체 또는 JSON 글)를 받아 ③ 검토 결과(2.0)와 같은 모양의 코드 점검 결과를 돌려줘요.
// problemSheet(readProblemSheet 결과)를 주면 문제지 '조립 정보' 표와도 대조해요.
export function reviewCodeReadAnalysis(analysis, { problemSheet = null } = {}) {
  const data = typeof analysis === "string" ? JSON.parse(analysis) : analysis;
  const elements = Array.isArray(data?.elements) ? data.elements : [];
  const texts = readTexts(elements);
  const rows = joinRows(texts);
  const lines = readHorizontalLines(elements);
  const chain = checkChainSums(texts, lines);
  const datums = checkDatums(texts, lines);
  const dimensions = readHorizontalDimensions(texts, lines);
  const drawnKeys = checkDrawnKeyWidths(texts, elements, dimensions);
  const own = [...chain.findings, ...checkFitSizes(rows), ...checkKeywayWidths(rows), ...drawnKeys.findings, ...datums.findings];
  const sheet = problemSheet ? compareWithSheet(problemSheet, texts, rows, dimensions, own) : null;
  const asked = askFittedParts(rows).filter((finding) => !sheet?.answered.has(finding.question.text.match(/^Ø([^ ]+)/)?.[1]));
  const raw = [...own, ...(sheet?.extra ?? []), ...(sheet?.roughness.extra ?? []), ...asked];
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
    not_missing: [...chain.passed, ...drawnKeys.passed, ...datums.passed, ...(sheet?.passed ?? []), ...(sheet?.roughness.passed ?? [])],
    limitations: [
      "코드 점검은 5가지 규칙만 봐요: ① 가로 직렬 치수 합계와 전체 치수(틀리면 그려진 길이로 어느 치수가 다른지 추정), ② 같은 끼워맞춤 기호(예: k6)가 붙은 지름 치수와 주석, ③ 키홈 폭 주석끼리, ④ N9·P9 키홈 폭 글자와 그려진 폭(가로 치수로 구한 축척 사용), ⑤ 기하공차가 참조하는 데이텀이 도면에 있는지.",
      "세로 치수, 지시선이 가리키는 대상, 설계 의도, 규격(KS) 적합성은 코드로 보지 않아요. 필요하면 ‘피드백 받기’로 ③ 검토를 이어서 받으세요.",
      "같은 부위인지 확실하지 않으면 '확인 필요'(노랑)로 남겼어요. 결과는 사람이 원본 도면과 직접 비교해야 해요.",
      ...(problemSheet ? [`문제지(${problemSheet.fileName || "선택한 파일"})의 '조립 정보' 표 글자와도 대조했어요. 문제지에 적힌 부품 자리에는 w·x·y·z 표면 거칠기 글자가 근처에 있는지, 키홈 깊이와 기하공차 값 글자가 있는지도 봐요. 조립도 그림과 공차 값이 맞는지는 코드로 보지 않아요.`] : []),
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
