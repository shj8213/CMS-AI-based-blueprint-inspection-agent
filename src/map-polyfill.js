// 일부 브라우저에는 Map·WeakMap의 getOrInsert, getOrInsertComputed가 아직 없어요.
// PDF 읽기 도구(pdf.js)가 이 기능을 쓰므로, 없을 때만 같은 동작으로 채워요.
export function installMapPolyfill(scope = globalThis) {
  for (const name of ["Map", "WeakMap"]) {
    const prototype = scope[name]?.prototype;
    if (!prototype) continue;
    if (typeof prototype.getOrInsert !== "function") {
      Object.defineProperty(prototype, "getOrInsert", {
        configurable: true,
        writable: true,
        value(key, value) {
          if (!this.has(key)) this.set(key, value);
          return this.get(key);
        },
      });
    }
    if (typeof prototype.getOrInsertComputed !== "function") {
      Object.defineProperty(prototype, "getOrInsertComputed", {
        configurable: true,
        writable: true,
        value(key, callback) {
          if (!this.has(key)) this.set(key, callback(key));
          return this.get(key);
        },
      });
    }
  }
}

installMapPolyfill();
