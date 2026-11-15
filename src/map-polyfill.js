// 일부 브라우저에는 Map의 getOrInsertComputed, Promise.try, Math.sumPrecise 등이 아직 없어요.
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

export function installModernApiPolyfill(scope = globalThis) {
  const { Promise: P, Math: M, URL: U } = scope;
  if (P && typeof P.try !== "function") {
    Object.defineProperty(P, "try", {
      configurable: true,
      writable: true,
      value(callback, ...args) {
        return new this((resolve) => resolve(callback(...args)));
      },
    });
  }
  if (P && typeof P.withResolvers !== "function") {
    Object.defineProperty(P, "withResolvers", {
      configurable: true,
      writable: true,
      value() {
        const result = {};
        result.promise = new this((resolve, reject) => {
          result.resolve = resolve;
          result.reject = reject;
        });
        return result;
      },
    });
  }
  if (M && typeof M.sumPrecise !== "function") {
    Object.defineProperty(M, "sumPrecise", {
      configurable: true,
      writable: true,
      value(values) {
        let sum = 0;
        for (const value of values) sum += value;
        return sum;
      },
    });
  }
  if (U && typeof U.parse !== "function") {
    Object.defineProperty(U, "parse", {
      configurable: true,
      writable: true,
      value(url, base) {
        try {
          return new U(url, base);
        } catch {
          return null;
        }
      },
    });
  }
}

installMapPolyfill();
installModernApiPolyfill();
