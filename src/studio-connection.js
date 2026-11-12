const MAX_FILE_SIZE = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT = 10 * 60 * 1000;
const POLL_INTERVAL = 3000;
const REQUEST_TEXT = "첨부한 도면을 실제로 읽을 수 있는지 확인하고 지침에 따라 분석해 주세요. 읽지 못한 내용은 그대로 알려 주세요.";

export class StudioConnectionError extends Error {}

function tokenEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new StudioConnectionError("② 연결 주소의 형식이 맞지 않아요. 연결 설정을 확인해 주세요.");
  }
  const allowedPath = /^\/(?:copilotstudio\/agenticruntime|powervirtualagents)\/botsbyschema\/[^/]+\/directline\/token$/;
  if (
    url.protocol !== "https:" || !url.hostname.endsWith(".environment.api.powerplatform.com")
    || url.port || url.username || url.password || url.hash || !allowedPath.test(url.pathname)
    || !url.searchParams.get("api-version")
    || [...url.searchParams.keys()].some((key) => key !== "api-version")
  ) {
    throw new StudioConnectionError("Microsoft ② 연결 주소가 아니에요. 연결 설정을 확인해 주세요.");
  }
  return url;
}

function directLineBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new StudioConnectionError("Microsoft가 보내 준 연결 주소를 확인할 수 없어요.");
  }
  const trustedHost = url.hostname === "directline.botframework.com"
    || url.hostname.endsWith(".directline.botframework.com");
  if (url.protocol !== "https:" || !trustedHost || url.port || url.username || url.password) {
    throw new StudioConnectionError("Microsoft가 보내 준 연결 주소를 확인할 수 없어요.");
  }
  return new URL("/v3/directline/", url);
}

async function readJson(response, label) {
  if (!response.ok) throw new StudioConnectionError(`${label}에 실패했어요. (HTTP ${response.status})`);
  try {
    return await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new StudioConnectionError(`${label} 응답을 읽을 수 없어요.`);
  }
}

function waitForPoll(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function analyzeDrawingWithStudio(file, {
  signal,
  onProgress = () => {},
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT,
  pollIntervalMs = POLL_INTERVAL,
} = {}) {
  if (!file || !file.name.toLowerCase().endsWith(".pdf")) {
    throw new StudioConnectionError("'도면 분석하기'는 PDF만 돼요. DXF는 '이 브라우저에서만 읽기'를 누르거나 PDF로 변환해 주세요.");
  }
  if (!file.size) throw new StudioConnectionError("빈 파일이에요. 내용이 있는 PDF를 선택해 주세요.");
  if (file.size > MAX_FILE_SIZE) throw new StudioConnectionError("PDF는 16MiB 이하로 선택해 주세요.");

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const request = (url, options = {}) => fetchImpl(url, {
    ...options,
    signal: controller.signal,
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  });

  try {
    onProgress("② 연결 설정을 확인하는 중이에요…");
    let configResponse;
    try {
      configResponse = await request("./agent-connection.local.json");
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new StudioConnectionError(
        "현재 홈페이지에서 연결 설정을 불러오지 못했어요. 홈페이지가 실행 중인지 확인하고 다시 열어 주세요.",
        { cause: error },
      );
    }
    if (configResponse.status === 404) {
      throw new StudioConnectionError("② 자동 연결 설정이 없어요. 작업 담당자에게 연결 설정을 요청해 주세요.");
    }
    const config = await readJson(configResponse, "② 연결 설정 읽기");
    const endpoint = tokenEndpoint(config?.tokenEndpoint);
    const regionUrl = new URL("/powervirtualagents/regionalchannelsettings", endpoint.origin);
    regionUrl.searchParams.set("api-version", endpoint.searchParams.get("api-version"));

    onProgress("②와 연결하는 중이에요…");
    const [tokenResponse, regionResponse] = await Promise.all([request(endpoint), request(regionUrl)]);
    const [tokenData, regionData] = await Promise.all([
      readJson(tokenResponse, "② 연결"),
      readJson(regionResponse, "연결 지역 확인"),
    ]);
    if (typeof tokenData?.token !== "string" || !tokenData.token) {
      throw new StudioConnectionError("② 연결 정보를 받지 못했어요. 연결 상태를 확인해 주세요.");
    }
    const base = directLineBase(regionData?.channelUrlsById?.directline);
    const conversationResponse = await request(new URL("conversations", base), {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenData.token}` },
    });
    const conversation = await readJson(conversationResponse, "② 대화 시작");
    if (typeof conversation?.conversationId !== "string" || !conversation.conversationId
      || typeof conversation.token !== "string" || !conversation.token) {
      throw new StudioConnectionError("② 대화를 시작할 정보를 받지 못했어요.");
    }
    const conversationUrl = new URL(`conversations/${encodeURIComponent(conversation.conversationId)}/`, base);
    const headers = { Authorization: `Bearer ${conversation.token}` };
    const userId = `dl_${crypto.randomUUID()}`;
    const form = new FormData();
    form.append("file", file.slice(0, file.size, "application/pdf"), file.name);
    form.append("activity", new Blob([JSON.stringify({
      type: "message",
      from: { id: userId },
      locale: "ko-KR",
      text: REQUEST_TEXT,
    })], { type: "application/vnd.microsoft.activity" }));
    const uploadUrl = new URL("upload", conversationUrl);
    uploadUrl.searchParams.set("userId", userId);

    onProgress("PDF를 ②에 보내는 중이에요…");
    const uploadResponse = await request(uploadUrl, { method: "POST", headers, body: form });
    const sent = await readJson(uploadResponse, "PDF 전송");
    if (typeof sent?.id !== "string" || !sent.id) {
      throw new StudioConnectionError("PDF가 정상적으로 전달됐는지 확인할 수 없어요.");
    }

    onProgress("②가 도면을 분석하고 있어요. 몇 분 정도 걸릴 수 있어요…");
    let watermark = null;
    const seen = new Set();
    const messages = [];
    while (true) {
      await waitForPoll(pollIntervalMs, controller.signal);
      const activitiesUrl = new URL("activities", conversationUrl);
      if (watermark !== null) activitiesUrl.searchParams.set("watermark", watermark);
      const activitiesResponse = await request(activitiesUrl, { headers });
      const data = await readJson(activitiesResponse, "② 응답 받기");
      if (!Array.isArray(data?.activities)) {
        throw new StudioConnectionError("② 응답 형식을 확인할 수 없어요.");
      }
      if (data.watermark != null) watermark = data.watermark;
      let complete = false;
      for (const activity of data.activities) {
        if (activity.replyToId !== sent.id) continue;
        if (activity.type === "message" && typeof activity.text === "string") {
          if (typeof activity.id !== "string" || !activity.id) {
            throw new StudioConnectionError("② 응답을 구분할 수 없어요.");
          }
          if (!seen.has(activity.id)) {
            seen.add(activity.id);
            messages.push(activity.text);
          }
        }
        if (activity.type === "event" && activity.name === "turn.complete") complete = true;
      }
      if (complete) {
        if (!messages.some((message) => message.trim())) {
          throw new StudioConnectionError("②가 분석 결과를 보내지 않았어요. 다시 시도해 주세요.");
        }
        return messages.join("\n\n");
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new StudioConnectionError(timedOut
        ? "② 응답을 기다리는 시간이 초과됐어요. 이미 보낸 PDF의 분석은 계속될 수 있어요."
        : "화면에서 기다리기를 중단했어요. PDF를 이미 보냈다면 분석은 계속될 수 있어요.");
    }
    if (error instanceof StudioConnectionError) throw error;
    throw new StudioConnectionError("②에 연결하지 못했어요. 인터넷과 연결 설정을 확인해 주세요.", { cause: error });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
