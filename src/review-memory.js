import { parseAgentResult } from "./agent-result.js";

const MAX_ENTRIES = 20;
const MAX_FINDINGS = 8;
const MAX_PATTERNS = 30;
const MAX_TEXT = 120;
const NOTATION_CATEGORIES = new Set(["치수", "치수공차", "기하공차", "표면거칠기", "표준참조"]);
// 비슷한 도면 기준: 도면 종류가 겹치고(필수), 표기 모양의 겹침이 이 값 이상이면 비슷하다고 봐요.
export const SIMILARITY_THRESHOLD = 0.6;

const clean = (value, limit = MAX_TEXT) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "");

function validEntry(entry) {
  return entry && typeof entry.id === "string" && typeof entry.savedAt === "string"
    && (entry.fingerprint === null || typeof entry.fingerprint === "string")
    && Array.isArray(entry.drawingTypes) && Array.isArray(entry.patterns) && Array.isArray(entry.findings)
    && entry.drawingTypes.every((item) => typeof item === "string")
    && entry.patterns.every((item) => typeof item === "string")
    && entry.findings.every((item) => item && typeof item.issueType === "string"
      && typeof item.classification === "string" && typeof item.what === "string");
}

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// 표기에서 숫자만 '#'로 바꿔 치수가 조금 달라도 같은 모양으로 비교해요. 예: Ø20h7 → Ø#h#
function notationPattern(element) {
  const text = clean(element.raw_text, 40).replace(/\d+(?:[.,]\d+)?/g, "#");
  return text && text !== "#" ? `${element.category}:${text}` : "";
}

// ② 결과에서 도면 종류와 표기 모양만 뽑아요. 파일 이름·좌표·치수 값은 넣지 않아요.
export function summarizeDrawing(analysisResponse) {
  let data;
  try {
    ({ data } = parseAgentResult(analysisResponse));
  } catch {
    return null;
  }
  const drawingTypes = [...new Set((data.features ?? [])
    .map((feature) => clean(feature.type, 30).toLowerCase().replace(/\s+/g, ""))
    .filter(Boolean))].sort();
  const patterns = [...new Set((data.elements ?? [])
    .filter((element) => NOTATION_CATEGORIES.has(element.category) && !element.needs_confirmation)
    .map(notationPattern)
    .filter(Boolean))].sort().slice(0, MAX_PATTERNS);
  return drawingTypes.length ? { drawingTypes, patterns } : null;
}

// ③ 결과에서 지적의 종류와 한 줄 설명만 뽑아요.
export function summarizeFindings(reviewResponse) {
  let data;
  try {
    ({ data } = parseAgentResult(reviewResponse));
  } catch {
    return [];
  }
  return (Array.isArray(data.findings) ? data.findings : []).slice(0, MAX_FINDINGS).map((finding) => ({
    classification: clean(finding.classification, 20),
    issueType: clean(finding.issue_type, 40),
    what: clean(finding.what),
  })).filter((finding) => finding.what && finding.issueType);
}

function jaccard(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  if (!left.size && !right.size) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function similarityScore(summary, entry) {
  if (!summary || !summary.drawingTypes.some((type) => entry.drawingTypes.includes(type))) return 0;
  return jaccard(summary.patterns, entry.patterns);
}

// 검토 기억은 이 브라우저(localStorage)에만 저장해요. 동의 없이 외부로 보내지 않아요.
export function createReviewMemory({ storage = browserStorage(), key = "blueprint-review-memory-v1" } = {}) {
  function list() {
    if (!storage) return [];
    try {
      const data = JSON.parse(storage.getItem(key) ?? "[]");
      return Array.isArray(data) ? data.filter(validEntry) : [];
    } catch {
      return [];
    }
  }

  function write(entries) {
    if (!storage) return false;
    if (!entries.length) {
      storage.removeItem(key);
      return true;
    }
    let remaining = entries.slice(0, MAX_ENTRIES);
    while (remaining.length) {
      try {
        storage.setItem(key, JSON.stringify(remaining));
        return true;
      } catch {
        remaining = remaining.slice(0, -1);
      }
    }
    return false;
  }

  return {
    list,
    save({ fingerprint = null, analysisResponse, reviewResponse }) {
      const summary = summarizeDrawing(analysisResponse);
      const findings = summarizeFindings(reviewResponse);
      if (!summary) return null;
      const entry = {
        id: crypto.randomUUID(),
        fingerprint,
        savedAt: new Date().toISOString(),
        ...summary,
        findings,
      };
      const others = list().filter((item) => !fingerprint || item.fingerprint !== fingerprint);
      return write([entry, ...others]) ? entry : null;
    },
    findSimilar(analysisResponse, fingerprint = null) {
      const summary = summarizeDrawing(analysisResponse);
      if (!summary) return null;
      let best = null;
      for (const entry of list()) {
        if (fingerprint && entry.fingerprint === fingerprint) continue;
        const score = similarityScore(summary, entry);
        if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) best = { entry, score };
      }
      return best;
    },
    remove(id) {
      write(list().filter((entry) => entry.id !== id));
    },
    clear() {
      storage?.removeItem(key);
    },
  };
}

// 동의했을 때 ③ 요청에 덧붙일 문장이에요. 화면에 보이는 미리보기와 같은 글을 보내요.
export function buildMemoryText(entry) {
  const lines = entry.findings.length
    ? entry.findings.map((finding, index) => `${index + 1}. [${finding.classification || "분류 없음"}] ${finding.issueType}: ${finding.what}`)
    : ["(지적이 없었어요)"];
  return [`도면 종류: ${entry.drawingTypes.join(", ")}`, "이전 지적 요약:", ...lines].join("\n");
}
