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
You MUST return ONLY a single JSON object with EXACT keys and casing:
{
  "token": "<lowercased word/phrase>",
  "model": "<model name>",
  "version": 1,
  "slots": {
    ${REL_NAMES.map((r) => `"${r}": []`).join(",\n    ")}
  },
  "meta": { "language":"en", "downloaded_at":"<ISO-8601>", "source":"LLM" }
}
Rules:
- 50 slot keys must ALL exist (empty arrays allowed).
- Each item in a slot: {"token":"<word/phrase>", "w": <float 0..1>}
- No extra properties anywhere. No markdown, no backticks, no commentary.
- Use EXACT slot key names from the list above; do not invent or rename.
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
  const now = new Date().toISOString();
  const out = {
    token: String(raw?.token ?? token).toLowerCase().trim(),
    model: String(raw?.model ?? model),
    version: 1,
    slots: Object.fromEntries(REL_NAMES.map((r) => [r, []])),
    meta: {
      language: "en",
      downloaded_at: now,
      source: "LLM"
    }
  };
  const errs = [];
  const meta = raw?.meta;
  if (meta && typeof meta === "object") {
    if (typeof meta.downloaded_at === "string") {
      out.meta.downloaded_at = meta.downloaded_at;
    }
  }
  const slots = raw?.slots && typeof raw.slots === "object" ? raw.slots : {};
  for (const [k, v] of Object.entries(slots)) {
    const canon = SLOTS_CANON_MAP[(k || "").replace(/\s+/g, "").toLowerCase()];
    if (!canon) {
      errs.push(`Unknown slot key "${k}" ignored`);
      continue;
    }
    if (!Array.isArray(v)) {
      errs.push(`Slot "${canon}" not an array; coerced to []`);
      continue;
    }
    for (let idx = 0; idx < v.length; idx++) {
      const item = v[idx] ?? {};
      const t = (item.token ?? item.word ?? item.t ?? "").toString().trim();
      if (!t) {
        errs.push(`slots["${canon}"][${idx}].token empty → dropped`);
        continue;
      }
      let rawW = Number(item.w);
      if (!Number.isFinite(rawW)) {
        errs.push(`slots["${canon}"][${idx}].w not number → 0`);
        rawW = 0;
      }
      const w = clamp(rawW, 0, 1);
      if (w !== rawW) {
        errs.push(`slots["${canon}"][${idx}].w clamped to ${w}`);
      }
      out.slots[canon].push({ token: t.toLowerCase(), w });
    }
  }
  return { out, errs };
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
  const { out, errs } = sanitizeAdjMatrix(raw, { token, model });
  const vErr = validateAdjMatrix(out);
  if (vErr) {
    const note = errs.length ? ` — notes: ${errs.join("; ")}` : "";
    throw new Error(`Schema mismatch: ${vErr}${note}`);
  }
  if (errs.length) {
    console.log(`ℹ normalized "${out.token}" (${errs.length} fixups)`);
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
