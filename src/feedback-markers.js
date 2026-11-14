// ③ 지적이 가리키는 ② 항목의 좌표로 도면 그림 위 동그라미 위치를 계산합니다.
// 좌표를 믿을 수 없으면 동그라미를 그리지 않고 "위치 확인 필요"로 남깁니다.

const MARKER_STYLES = {
  "틀림": { color: "red", symbol: "!", label: "틀림" },
  "확인 필요": { color: "yellow", symbol: "?", label: "확인 필요" },
};
const MIN_RADIUS = 0.015;
const POINT_RADIUS = 0.02;
const EDGE_TOLERANCE = 0.02;
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

export function buildFeedbackMarkers(review, analysis) {
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
      if (!Number.isInteger(element.page_number)) {
        reasons.push(`${id} 항목의 페이지 번호가 없어요.`);
        continue;
      }
      const { placement, reason } = placeElement(element, pages.get(element.page_number));
      if (placement) placements.push(placement);
      else reasons.push(`${id}: ${reason}`);
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

// 실제 PDF 페이지 비율이 ② 결과의 페이지 크기와 다르면 위치가 어긋날 수 있어 그리지 않습니다.
export function pageMatches(placement, renderedPage) {
  const expected = placement.pageWidth / placement.pageHeight;
  const actual = renderedPage.width / renderedPage.height;
  return Math.abs(expected - actual) / actual <= ASPECT_TOLERANCE;
}
