const MAX_ENTRIES = 20;

export async function fileFingerprint(file) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validEntry(entry) {
  return entry && typeof entry.id === "string" && typeof entry.fileName === "string"
    && typeof entry.response === "string" && typeof entry.savedAt === "string"
    && (entry.fingerprint === null || typeof entry.fingerprint === "string")
    && (entry.kind === undefined || entry.kind === "analysis" || entry.kind === "review")
    && (entry.reviewResponse === undefined || typeof entry.reviewResponse === "string")
    && (entry.verified === undefined || typeof entry.verified === "boolean");
}

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// 분석 결과를 이 브라우저(localStorage)에만 저장해요. 외부로 보내지 않아요.
export function createAnalysisHistory({ storage = browserStorage(), key = "blueprint-analysis-history-v1" } = {}) {
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
    if (!storage) return 0;
    if (!entries.length) {
      storage.removeItem(key);
      return 0;
    }
    let remaining = entries.slice(0, MAX_ENTRIES);
    while (remaining.length) {
      try {
        storage.setItem(key, JSON.stringify(remaining));
        return remaining.length;
      } catch {
        remaining = remaining.slice(0, -1);
      }
    }
    return 0;
  }

  return {
    list,
    find(fingerprint) {
      return fingerprint ? list().find((entry) => entry.fingerprint === fingerprint) ?? null : null;
    },
    get(id) {
      return list().find((entry) => entry.id === id) ?? null;
    },
    save({ fileName, fingerprint, response, kind = "analysis" }) {
      const entry = {
        id: crypto.randomUUID(),
        fileName,
        fingerprint: fingerprint ?? null,
        response,
        ...(kind === "review" ? { kind } : {}),
        savedAt: new Date().toISOString(),
        verified: false,
      };
      const others = list().filter((item) => !fingerprint || item.fingerprint !== fingerprint);
      const kept = write([entry, ...others]);
      return kept > 0 ? entry : null;
    },
    setVerified(id, verified) {
      const entries = list();
      const entry = entries.find((item) => item.id === id);
      if (!entry) return false;
      entry.verified = Boolean(verified);
      return write(entries) === entries.length;
    },
    saveReview(id, response) {
      const entries = list();
      const entry = entries.find((item) => item.id === id);
      if (!entry) return false;
      entry.reviewResponse = response;
      return write(entries) === entries.length;
    },
    remove(id) {
      write(list().filter((entry) => entry.id !== id));
    },
    clear() {
      storage?.removeItem(key);
    },
  };
}
