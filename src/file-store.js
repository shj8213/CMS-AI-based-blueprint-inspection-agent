// 분석한 원본 PDF를 이 브라우저(IndexedDB)에만 보관해, 새로고침 뒤에도 피드백을 받을 때 파일을 다시 고르지 않게 해요.
// 어디로도 전송하지 않고, 최근 MAX_FILES개만 남겨요.
const DB_NAME = "blueprint-analyzed-files-v1";
const STORE = "files";
const MAX_FILES = 10;

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB 없음"));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "fingerprint" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function saveAnalyzedFile(fingerprint, file) {
  if (!fingerprint || !file) return;
  try {
    const db = await open();
    const buffer = await file.arrayBuffer();
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    store.put({ fingerprint, name: file.name, type: file.type, buffer, savedAt: Date.now() });
    const all = store.getAll();
    all.onsuccess = () => {
      all.result.sort((a, b) => b.savedAt - a.savedAt).slice(MAX_FILES)
        .forEach((old) => store.delete(old.fingerprint));
    };
    await done(transaction);
    db.close();
  } catch (error) {
    console.error("원본 PDF 보관 실패:", error instanceof Error ? error.name : typeof error);
  }
}

export async function loadAnalyzedFile(fingerprint) {
  if (!fingerprint) return null;
  try {
    const db = await open();
    const record = await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(fingerprint);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return record ? new File([record.buffer], record.name, { type: record.type }) : null;
  } catch {
    return null;
  }
}

export async function clearAnalyzedFiles() {
  try {
    const db = await open();
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).clear();
    await done(transaction);
    db.close();
  } catch (error) {
    console.error("원본 PDF 삭제 실패:", error instanceof Error ? error.name : typeof error);
  }
}
