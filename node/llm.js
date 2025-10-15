const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const REL_NAMES = [
  "Identity","Contains","Is Contained By","Variant","Is Instance Of","Has Instance",
  "Is Type Of","Has Type","Part Of","Composes","Mirrors","Inverts","Parallel To",
  "Adjacent To","Next","Sequence Of","Preceded By","Follows","Spatially Above",
  "Spatially Below","Symbolically Supports","Symbolically Depends","Contrasts",
  "Complements","Associated With","Correlates With","Causes","Caused By","Evokes",
  "Represents","Symbolizes","Refers To","Defines","Is Defined By","Transforms To",
  "Transformed From","Functions As","Interpreted As","Used With","Co-occurs With",
  "Synthesizes","Divides Into","Opposes","Generalizes","Specializes","Analogous To",
  "Prerequisite Of","Result Of","Context For","Exception Of"
];

const ADJ_SYS = `
Return ONLY a single JSON object with EXACT keys (no extras). All 50 slots must exist.
Seed requirement: populate at least 3 neighbors (w>0) for EACH of these slots if known:
"Co-occurs With","Associated With","Sequence Of","Represents","Symbolizes","Defines".
Distribute 3–8 items per populated slot, weights in 0..1 (not all identical), prefer topical coherence.
Schema:
{"token": "<lowercase>", "model": "<ignored>", "version":1,
 "slots": { ...50 exact keys... }, "meta":{"language":"en","downloaded_at":"<ISO>","source":"LLM"}}
Return JSON only.
`;

const SLOTS_CANON_MAP = (() => {
  const m = {};
  for (const k of REL_NAMES) {
    m[k.toLowerCase()] = k;
    m[k.replace(/\s+/g, "").toLowerCase()] = k;
  }
  return m;
})();

const clamp = (x, min, max) => Math.max(min, Math.min(max, x));

function safeExtractJSON(s) {
  try {
    return JSON.parse(s);
  } catch (err) {
    // fall through
  }
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(s.slice(i, j + 1));
    } catch (err) {
      // ignore
    }
  }
  return null;
}

function sanitizeAdjMatrix(raw, { token, model }) {
  const out = {
    token: String(token).toLowerCase().trim(),
    model: String(model),
    version: 1,
    slots: Object.fromEntries(REL_NAMES.map((r) => [r, []])),
    meta: {
      language: "en",
      downloaded_at: new Date().toISOString(),
      source: "LLM"
    }
  };
  let nonEmpty = 0;
  const slots = raw?.slots && typeof raw.slots === "object" ? raw.slots : {};
  for (const [key, value] of Object.entries(slots)) {
    const canon = SLOTS_CANON_MAP[(key || "").replace(/\s+/g, "").toLowerCase()];
    if (!canon || !Array.isArray(value)) continue;
    for (const entry of value) {
      const t = String(entry?.token ?? "").toLowerCase().trim();
      let w = Number(entry?.w);
      if (!t) continue;
      if (!Number.isFinite(w)) w = 0;
      w = clamp(w, 0, 1);
      out.slots[canon].push({ token: t, w });
      if (w > 0) nonEmpty++;
    }
  }
  return { out, nonEmpty };
}

function validateAdjMatrix(obj) {
  if (typeof obj !== "object" || obj === null) return "Not an object";
  if (obj.version !== 1) return "version !== 1";
  if (!obj.token) return "missing token";
  if (!obj.model) return "missing model";
  if (!obj.meta || obj.meta.language !== "en" || obj.meta.source !== "LLM") return "bad meta";
  if (!obj.meta.downloaded_at) return "missing downloaded_at";
  if (!obj.slots || typeof obj.slots !== "object") return "missing slots";
  for (const r of REL_NAMES) {
    if (!Array.isArray(obj.slots[r])) return `missing or non-array slot "${r}"`;
    for (let i = 0; i < obj.slots[r].length; i++) {
      const it = obj.slots[r][i];
      if (!it || typeof it.token !== "string") return `slots["${r}"][${i}].token invalid`;
      if (typeof it.w !== "number" || it.w < 0 || it.w > 1) {
        return `slots["${r}"][${i}].w out of range`;
      }
    }
  }
  return null;
}

function parseSSE(buffer, onChunk) {
  const lines = buffer.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      onChunk(parsed);
    } catch {
      // ignore malformed keep-alives
    }
  }
}

export async function streamChat({ apiKey, model, messages, signal }) {
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, messages, stream: true }),
    signal
  });
  if (!res.ok) {
    throw new Error(`OpenAI error: ${res.status}`);
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const queue = [];
  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        parseSSE(buffer, (event) => {
          const delta = event.choices?.[0]?.delta?.content;
          if (delta) queue.push(delta);
        });
        let idx = buffer.lastIndexOf("\n");
        if (idx !== -1) {
          buffer = buffer.slice(idx + 1);
        }
        while (queue.length) {
          yield queue.shift();
        }
      }
    },
    queue
  };
}

async function requestJSON({ apiKey, model, token }) {
  const user = `token="${token}" — return JSON only.`;
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: ADJ_SYS },
        { role: "user", content: user }
      ],
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`OpenAI error: ${res.status}`);
    error.body = text;
    error.status = res.status;
    throw error;
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  const raw = safeExtractJSON(text);
  if (!raw) throw new Error("Adjacency JSON parse failed");
  const { out, nonEmpty } = sanitizeAdjMatrix(raw, { token, model });
  const vErr = validateAdjMatrix(out);
  if (vErr) {
    throw new Error(`Schema mismatch: ${vErr}`);
  }
  if (nonEmpty === 0) {
    throw new Error("Empty matrix; retrying with stricter seed");
  }
  return out;
}

export async function getAdjMatrix({ apiKey, model, token, retries = 4 }) {
  const delays = [1000, 2000, 4000, 8000];
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await requestJSON({ apiKey, model, token });
    } catch (err) {
      if (attempt === retries) throw err;
      const status = err?.status || err?.cause?.status;
      if (status && status < 500 && status !== 429) throw err;
      const delay = delays[Math.min(attempt, delays.length - 1)];
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Failed to fetch adjacency matrix");
}

export function isJunkMatrix(mat) {
  if (!mat || typeof mat !== "object") return true;
  const badModel = /default|model_name|language_model/i.test(mat.model || "");
  const downloaded = Date.parse(mat.meta?.downloaded_at || 0);
  const tooOld = Number.isFinite(downloaded) ? downloaded < Date.parse("2024-01-01") : true;
  const empty = REL_NAMES.every((rel) => Array.isArray(mat.slots?.[rel]) && mat.slots[rel].length === 0);
  return badModel || tooOld || empty;
}
