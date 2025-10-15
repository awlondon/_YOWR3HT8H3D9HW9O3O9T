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

const ADJ_BASE = `
Return ONLY one JSON object, EXACT keys, all 50 slots present (empty arrays allowed).
Populate at least 12 neighbors total across ≥6 of these slots:
"Co-occurs With","Associated With","Sequence Of","Defines","Represents","Symbolizes","Refers To".
Each item: {"token":"<word/phrase>","w":<float 0..1>} (descending by w). No extras, no commentary.`;

const ADJ_FORCED = `
Same schema and rules, but if uncertain you MUST still populate ≥24 neighbors total across ≥8 slots
using broadly relevant, safe, generic associations. No empty result is allowed.`;

const CONTEXT_HINT_SYS = "Return a single short sentence giving the domain/sense of the given word/phrase, followed by 6 comma-separated key facets. No markdown.";

const MIN_NEIGHBORS_BASE = 12;
const MIN_NEIGHBORS_FORCED = 24;

const PASS1_STATUS = "Empty matrix → retry with context";
const PASS2_STATUS = "Still sparse → forced population";
const PASS3_STATUS = "LLM still empty → bootstrap seeding applied";

const FEWSHOT = {
  token: "photosynthesis",
  model: "ignored",
  version: 1,
  slots: Object.fromEntries(REL_NAMES.map((name) => [name, []]))
};

FEWSHOT.slots["Co-occurs With"] = [
  { token: "chlorophyll", w: 0.96 },
  { token: "light energy", w: 0.91 },
  { token: "carbon dioxide", w: 0.88 }
];
FEWSHOT.slots["Defines"] = [
  { token: "conversion of light to chemical energy", w: 0.93 },
  { token: "glucose production", w: 0.84 },
  { token: "oxygen release", w: 0.82 }
];

const FEWSHOT_STRING = JSON.stringify(FEWSHOT);

const debugLog = (msg) => {
  if (typeof console !== "undefined" && typeof console.debug === "function") {
    console.debug(msg);
  }
};

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
  const meta = obj.meta;
  if (
    !meta ||
    meta.language !== "en" ||
    (meta.source !== "LLM" && meta.source !== "BOOTSTRAP")
  ) {
    return "bad meta";
  }
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

async function getContextHint({ apiKey, model, token }) {
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      messages: [
        { role: "system", content: CONTEXT_HINT_SYS },
        { role: "user", content: `Token: "${token}"` }
      ]
    })
  });
  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`OpenAI ${res.status}`);
    error.body = text;
    error.status = res.status;
    throw error;
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  return text.slice(0, 300);
}

async function callAdjLLM({ apiKey, model, token, context, forced = false }) {
  const sys = (forced ? ADJ_FORCED : ADJ_BASE) +
    `\nSchema:\n{"token":"<lowercase>","model":"<ignored>","version":1,"slots":{...50 keys...},"meta":{"language":"en","downloaded_at":"<ISO>","source":"LLM"}}`;
  const user = `token="${String(token).toLowerCase()}". Context: ${context || "n/a"}. Example JSON (style only):\n${FEWSHOT_STRING}`;
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: forced ? 0.6 : 0.4,
      top_p: 0.95,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ],
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`OpenAI ${res.status}`);
    error.body = text;
    error.status = res.status;
    throw error;
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "{}";
}

function suggestGenericNeighbors(token) {
  const commons = ["meaning", "context", "usage", "definition", "example", "related term", "synonym"];
  const lower = String(token || "").toLowerCase();
  return commons.filter((item) => item !== lower).slice(0, 6);
}

export async function getAdjMatrix({ apiKey, model, token, retries = 4 }) {
  const delays = [1000, 2000, 4000, 8000];
  const shouldRetry = (err) => {
    const status = err?.status || err?.cause?.status;
    return !status || status >= 500 || status === 429;
  };
  const execWithRetry = async (fn) => {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt === retries || !shouldRetry(err)) {
          throw err;
        }
        const delay = delays[Math.min(attempt, delays.length - 1)];
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  };

  const parse = (text) => {
    const raw = safeExtractJSON(text);
    if (!raw) throw new Error("Adjacency JSON parse failed");
    return raw;
  };

  const callWithRetry = (params) => execWithRetry(() => callAdjLLM({ apiKey, model, ...params }));
  const fetchContext = () => execWithRetry(() => getContextHint({ apiKey, model, token }));

  let text = await callWithRetry({ token });
  let raw = parse(text);
  let { out, nonEmpty } = sanitizeAdjMatrix(raw, { token, model });
  let vErr = validateAdjMatrix(out);
  if (vErr) throw new Error(`Schema mismatch: ${vErr}`);
  if (nonEmpty >= MIN_NEIGHBORS_BASE) {
    return out;
  }
  debugLog(PASS1_STATUS);

  let context = "";
  try {
    context = await fetchContext();
  } catch (err) {
    debugLog(`Context hint failed: ${err.message}`);
    context = "";
  }

  text = await callWithRetry({ token, context });
  raw = parse(text);
  ({ out, nonEmpty } = sanitizeAdjMatrix(raw, { token, model }));
  vErr = validateAdjMatrix(out);
  if (vErr) throw new Error(`Schema mismatch: ${vErr}`);
  if (nonEmpty >= MIN_NEIGHBORS_BASE) {
    return out;
  }
  debugLog(PASS2_STATUS);

  text = await callWithRetry({ token, context, forced: true });
  raw = parse(text);
  ({ out, nonEmpty } = sanitizeAdjMatrix(raw, { token, model }));
  vErr = validateAdjMatrix(out);
  if (vErr) throw new Error(`Schema mismatch: ${vErr}`);
  if (nonEmpty >= MIN_NEIGHBORS_FORCED) {
    return out;
  }
  debugLog(PASS3_STATUS);

  out.meta.source = "BOOTSTRAP";
  out.meta.downloaded_at = new Date().toISOString();
  out.slots["Co-occurs With"] = suggestGenericNeighbors(token).map((item, idx) => ({
    token: item,
    w: Math.max(0.3, 0.9 - 0.05 * idx)
  }));
  const bootstrapErr = validateAdjMatrix(out);
  if (bootstrapErr) {
    throw new Error(`Schema mismatch: ${bootstrapErr}`);
  }
  return out;
}

export function isJunkMatrix(mat) {
  if (!mat || typeof mat !== "object") return true;
  const badModel = /default|model_name|language_model/i.test(mat.model || "");
  const downloaded = Date.parse(mat.meta?.downloaded_at || 0);
  const tooOld = Number.isFinite(downloaded) ? downloaded < Date.parse("2024-01-01") : true;
  const empty = REL_NAMES.every((rel) => Array.isArray(mat.slots?.[rel]) && mat.slots[rel].length === 0);
  return badModel || tooOld || empty;
}
