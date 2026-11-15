// ③ 지적이 가리키는 ② 항목의 위치를 도면 그림 위 동그라미로 계산합니다.
// 1) ②가 기록한 좌표를 먼저 쓰고, 2) 없으면 원본 PDF의 글자 중 ② 원문과 같은 곳을 찾습니다.
// 어느 쪽도 확실하지 않으면 동그라미를 그리지 않고 "위치 확인 필요"로 남깁니다.

const MARKER_STYLES = {
  "틀림": { color: "tone-red", symbol: "!", label: "틀림" },
  "확인 필요": { color: "tone-orange", symbol: "?", label: "확인 필요" },
};
const MIN_RADIUS = 0.015;
const POINT_RADIUS = 0.02;
const EDGE_TOLERANCE = 0.02;
const MAX_TEXT_CANDIDATES = 3;
export const ASPECT_TOLERANCE = 0.03;

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

export function originDirection(origin) {
  if (typeof origin !== "string") return null;
  const text = origin.toLowerCase().replace(/\s+/g, "");
  if (/왼쪽위|좌상단?|top-?left|upper-?left/.test(text)) return "down";
  if (/왼쪽아래|좌하단?|bottom-?left|lower-?left/.test(text)) return "up";
  return null;
}

function placeElement(element, page) {
  const location = element.location;
  if (!location || typeof location !== "object") return { reason: "② 항목에 좌표가 없어요." };

  let x0, y0, x1, y1;
  const { bbox } = location;
  if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(isNumber) && bbox[2] >= bbox[0] && bbox[3] >= bbox[1]) {
    [x0, y0, x1, y1] = bbox;
  } else if (isNumber(location.x) && isNumber(location.y)) {
    x0 = x1 = location.x;
    y0 = y1 = location.y;
  } else {
    return { reason: "② 항목에 좌표가 없어요." };
  }
  if (!page) return { reason: "② 결과에 이 항목의 페이지 정보가 없어요." };
  if (!isNumber(page.width) || !isNumber(page.height) || page.width <= 0 || page.height <= 0) {
    return { reason: "② 결과에 페이지 크기가 없어요." };
  }
  const direction = originDirection(page.coordinate_origin);
  if (!direction) return { reason: "② 결과의 좌표 기준점을 알 수 없어요." };
  if (!location.coordinate_unit || !page.coordinate_unit || location.coordinate_unit !== page.coordinate_unit) {
    return { reason: "② 항목과 페이지의 좌표 단위가 같은지 확인할 수 없어요." };
  }

  const left = x0 / page.width;
  const right = x1 / page.width;
  let top = y0 / page.height;
  let bottom = y1 / page.height;
  if (direction === "up") [top, bottom] = [1 - bottom, 1 - top];
  const inside = (value) => value >= -EDGE_TOLERANCE && value <= 1 + EDGE_TOLERANCE;
  if (![left, right, top, bottom].every(inside)) {
    return { reason: "② 항목의 좌표가 페이지 밖을 가리켜요." };
  }

  const isPoint = x0 === x1 && y0 === y1;
  // 반지름은 페이지 너비 기준 비율입니다. 높이 방향은 화면에서 너비 비율로 다시 맞춥니다.
  const halfWidth = (right - left) / 2;
  const halfHeight = ((bottom - top) / 2) * (page.height / page.width);
  return {
    placement: {
      page: element.page_number,
      x: (left + right) / 2,
      y: (top + bottom) / 2,
      radius: isPoint ? POINT_RADIUS : Math.max(MIN_RADIUS, Math.hypot(halfWidth, halfHeight) * 1.15),
      elementId: element.id,
      pageWidth: page.width,
      pageHeight: page.height,
    },
  };
}

export function normalizeDrawingText(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[ΦφØø⌀∅]/g, "Ø")
    .replace(/[−–—]/g, "-")
    .replace(/[×✕]/g, "x")
    .replace(/[\s|]+/g, "")
    .toLowerCase();
}

function unionBox(boxes) {
  return [
    Math.min(...boxes.map((box) => box[0])), Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])), Math.max(...boxes.map((box) => box[3])),
  ];
}

// 같은 줄에 붙어 있는 PDF 글자 조각을 이어 붙여 검색합니다. 멀리 떨어진 조각은 "\n"으로 끊어 잘못 이어지지 않게 합니다.
function textLines(texts) {
  const horizontal = texts.filter((item) => item.horizontal).sort((a, b) => a.baseline - b.baseline || a.box[0] - b.box[0]);
  const lines = [];
  for (const item of horizontal) {
    const line = lines.find((candidate) => Math.abs(candidate.baseline - item.baseline) <= Math.max(1, item.height * 0.4));
    if (line) line.items.push(item);
    else lines.push({ baseline: item.baseline, items: [item] });
  }
  const result = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.box[0] - b.box[0]);
    let text = "";
    const owners = [];
    line.items.forEach((item, index) => {
      const previous = line.items[index - 1];
      if (previous && item.box[0] - previous.box[2] > Math.max(previous.height, item.height) * 1.5) {
        text += "\n";
        owners.push(null);
      }
      const normalized = normalizeDrawingText(item.text);
      text += normalized;
      for (let i = 0; i < normalized.length; i += 1) owners.push(item);
    });
    result.push({ text, owners });
  }
  for (const item of texts.filter((candidate) => !candidate.horizontal)) {
    const normalized = normalizeDrawingText(item.text);
    result.push({ text: normalized, owners: [...normalized].map(() => item) });
  }
  return result;
}

export function findTextMatches(rawText, pageText) {
  const target = normalizeDrawingText(rawText);
  if (!target || target.includes("?")) return [];
  const matches = [];
  for (const line of textLines(pageText.texts)) {
    let index = line.text.indexOf(target);
    while (index !== -1) {
      const end = index + target.length;
      const owners = [...new Set(line.owners.slice(index, end))].filter(Boolean);
      // 글자 조각의 경계와 딱 맞는 결과("20")를 다른 글자 속 일부("2026")보다 먼저 씁니다.
      const whole = line.owners[index - 1] !== line.owners[index] && line.owners[end] !== line.owners[end - 1];
      if (owners.length) matches.push({ box: unionBox(owners.map((item) => item.box)), whole });
      index = line.text.indexOf(target, index + 1);
    }
  }
  const whole = matches.filter((match) => match.whole);
  return (whole.length ? whole : matches).map((match) => match.box);
}

function boxPlacement(box, pageNumber, page, elementId, source) {
  const [x0, y0, x1, y1] = box;
  const halfWidth = (x1 - x0) / page.width / 2;
  const halfHeight = (y1 - y0) / page.width / 2;
  return {
    page: pageNumber,
    x: (x0 + x1) / 2 / page.width,
    y: (y0 + y1) / 2 / page.height,
    radius: Math.max(MIN_RADIUS, Math.hypot(halfWidth, halfHeight) * 1.2),
    elementId,
    pageWidth: page.width,
    pageHeight: page.height,
    source,
    candidate: false,
  };
}

function placeByText(element, pdfPages) {
  if (!pdfPages) return { reason: "원본 PDF가 없어 글자로 위치를 찾지 못했어요." };
  if (typeof element.raw_text !== "string" || !normalizeDrawingText(element.raw_text)) {
    return { reason: "② 항목에 좌표와 읽은 글자가 없어요." };
  }
  if (element.raw_text.includes("?")) return { reason: "② 원문에 읽지 못한 글자가 있어 위치를 찾지 못했어요." };
  const pages = Number.isInteger(element.page_number)
    ? [pdfPages.get(element.page_number)].filter(Boolean)
    : [...pdfPages.values()];
  const found = pages.flatMap((page) => findTextMatches(element.raw_text, page)
    .map((box) => boxPlacement(box, page.pageNumber, page, element.id, "text")));
  if (!found.length) return { reason: `PDF 글자에서 ‘${element.raw_text}’를 찾지 못했어요.` };
  if (found.length > MAX_TEXT_CANDIDATES) {
    return { reason: `‘${element.raw_text}’가 PDF에 ${found.length}곳 있어 위치를 하나로 정하지 못했어요.` };
  }
  if (found.length > 1) for (const placement of found) placement.candidate = true;
  return { placements: found };
}

// pdfPages: 페이지 번호 → { pageNumber, width, height, texts } (원본 PDF에서 읽은 글자 위치, 선택)
export function buildFeedbackMarkers(review, analysis, pdfPages = null) {
  const elements = new Map();
  for (const element of analysis?.elements ?? []) {
    if (element && typeof element.id === "string") elements.set(element.id, element);
  }
  const pages = new Map();
  for (const page of analysis?.pages ?? []) {
    if (page && Number.isInteger(page.page_number)) pages.set(page.page_number, page);
  }

  return (review?.findings ?? []).map((finding, index) => {
    const style = MARKER_STYLES[finding.classification] ?? MARKER_STYLES["확인 필요"];
    const placements = [];
    const reasons = [];
    for (const id of finding.analysis_item_ids ?? []) {
      const element = elements.get(id);
      if (!element) {
        reasons.push(analysis ? `② 결과에서 ${id} 항목을 찾지 못했어요.` : "② 분석 결과가 없어요.");
        continue;
      }
      let coordinateReason = `${id} 항목의 페이지 번호가 없어요.`;
      if (Number.isInteger(element.page_number)) {
        const { placement, reason } = placeElement(element, pages.get(element.page_number));
        if (placement) {
          placements.push({ ...placement, source: "coordinate", candidate: false });
          continue;
        }
        coordinateReason = reason;
      }
      const byText = placeByText(element, pdfPages);
      if (byText.placements) placements.push(...byText.placements);
      else reasons.push(`${id}: ${pdfPages ? byText.reason : coordinateReason}`);
    }
    if (!finding.analysis_item_ids?.length) reasons.push("연결된 ② 항목이 없어요.");
    return {
      findingId: finding.id,
      number: index + 1,
      classification: finding.classification,
      ...style,
      placements,
      reason: placements.length ? "" : [...new Set(reasons)].join(" "),
    };
  });
}

// ② 결과가 가리키는 페이지 번호 목록입니다. 페이지가 없는 항목이 있으면 null(전체 페이지)을 돌려줍니다.
export function referencedPages(review, analysis) {
  const elements = new Map((analysis?.elements ?? []).map((element) => [element?.id, element]));
  const numbers = new Set();
  for (const finding of review?.findings ?? []) {
    for (const id of finding.analysis_item_ids ?? []) {
      const element = elements.get(id);
      if (!element) continue;
      if (!Number.isInteger(element.page_number)) return null;
      numbers.add(element.page_number);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

// 실제 PDF 페이지 비율이 ② 결과의 페이지 크기와 다르면 위치가 어긋날 수 있어 그리지 않습니다.
export function pageMatches(placement, renderedPage) {
  const expected = placement.pageWidth / placement.pageHeight;
  const actual = renderedPage.width / renderedPage.height;
  return Math.abs(expected - actual) / actual <= ASPECT_TOLERANCE;
}
