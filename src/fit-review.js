const LIMIT = "이 결과는 끼워맞춤 표기 후보의 존재 여부만 확인해요. KS 적합 여부나 전체 도면의 정확성을 보증하지 않아요.";

function isUncertain(element) {
  return Boolean(element.uncertain) || (element.source === "ocr" &&
    (!Number.isFinite(element.confidence) || element.confidence < 80));
}

function textRuns(result) {
  const runs = [];
  for (const element of result.elements.filter((entry) => entry.kind === "text")) {
    const previous = runs.at(-1);
    const last = previous?.elements.at(-1);
    let adjacent = false;
    if (result.format === "PDF" && last && last.page === element.page &&
        last.source === element.source && Number.isFinite(last.width) &&
        Math.abs(last.rotation - element.rotation) < 0.01) {
      const angle = last.rotation * Math.PI / 180;
      const dx = element.position.x - last.position.x;
      const dy = element.position.y - last.position.y;
      const gap = dx * Math.cos(angle) + dy * Math.sin(angle) - last.width;
      const baseline = -dx * Math.sin(angle) + dy * Math.cos(angle);
      const height = Math.max(last.height, element.height);
      adjacent = Math.abs(baseline) < height * 0.25 && gap >= -height * 0.2 && gap <= height;
    }
    if (adjacent) {
      previous.text += ` ${element.text}`;
      previous.elements.push(element);
    } else {
      runs.push({ text: element.text, elements: [element] });
    }
  }
  return runs;
}

export function reviewFitNotation(result) {
  const texts = result.elements.filter((element) => element.kind === "text");
  const candidates = [];
  for (const run of textRuns(result)) {
    // 숫자·영문 식별자 안의 일부를 표기로 오인하지 않도록 양쪽 경계를 확인해요.
    const pattern = /(?<![A-Za-z0-9])(?:[Ø⌀Φφ]?\s*\d+(?:[.,]\d+)?\s*)?([A-Z]{1,2}\d{1,2})\s*\/\s*([a-z]{1,2}\d{1,2})(?![A-Za-z0-9])/g;
    for (const match of run.text.matchAll(pattern)) {
      let start = 0;
      const evidence = run.elements.filter((element) => {
        const end = start + element.text.length;
        const overlaps = start < match.index + match[0].length && end > match.index;
        start = end + 1;
        return overlaps;
      });
      candidates.push({
        notation: `${match[1]}/${match[2]}`,
        evidence,
        uncertain: evidence.some(isUncertain),
      });
    }
  }
  const reasons = [...result.textCoverage.reasons];
  if (!texts.length) reasons.push("검사할 글자를 읽지 못했어요.");
  if (texts.some(isUncertain)) reasons.push("일부 글자의 읽기 결과나 OCR 신뢰도가 불확실해요.");
  const reliableCandidates = candidates.filter((candidate) => !candidate.uncertain);
  const state = reliableCandidates.length ? "문제 후보"
    : candidates.length || reasons.length ? "확인할 수 없음" : "이상 없음";
  const reason = state === "문제 후보"
    ? "사람이 확인할 끼워맞춤 표기 후보를 찾았어요. 규격 위반이나 오류라는 뜻은 아니에요."
    : state === "이상 없음"
      ? "신뢰할 수 있게 읽은 글자에서 이 규칙의 표기 후보를 찾지 못했어요."
      : "글자 또는 검사 범위를 신뢰할 수 없어 표기 후보의 존재 여부를 단정하지 않아요.";
  return { state, reason, reasons, candidates, checkedTexts: texts.length, limit: LIMIT };
}
