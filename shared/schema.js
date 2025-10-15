import { RELATIONSHIP_NAMES } from "./relationships.js";

export const ADJ_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["token", "model", "version", "slots", "meta"],
  properties: {
    token: { type: "string" },
    model: { type: "string" },
    version: { type: "integer", const: 1 },
    slots: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        RELATIONSHIP_NAMES.map((rel) => [
          rel,
          {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["token", "w"],
              properties: {
                token: { type: "string" },
                w: { type: "number", minimum: 0, maximum: 1 }
              }
            }
          }
        ])
      ),
      required: RELATIONSHIP_NAMES
    },
    meta: {
      type: "object",
      additionalProperties: false,
      required: ["language", "downloaded_at", "source"],
      properties: {
        language: { type: "string", const: "en" },
        downloaded_at: { type: "string" },
        source: { type: "string", const: "LLM" }
      }
    }
  }
};

export const HL_RUN_LOG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "inputPrompt",
    "originalLLM",
    "refined",
    "emergentThoughts",
    "steps",
    "tokensIn",
    "tokensOut"
  ],
  properties: {
    id: { type: "string" },
    inputPrompt: { type: "string" },
    originalLLM: { type: "string" },
    refined: { type: "string" },
    emergentThoughts: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "t0", "t1", "ok"],
        properties: {
          name: { type: "string" },
          t0: { type: "number" },
          t1: { type: "number" },
          ok: { type: "boolean" },
          note: { type: "string" }
        }
      }
    },
    tokensIn: { type: "array", items: { type: "string" } },
    tokensOut: { type: "array", items: { type: "string" } }
  }
};

function isPlainObject(val) {
  return Object.prototype.toString.call(val) === "[object Object]";
}

export function validateAdjacencyMatrix(value) {
  if (!isPlainObject(value)) return false;
  const { token, model, version, slots, meta } = value;
  if (typeof token !== "string" || typeof model !== "string") return false;
  if (version !== 1) return false;
  if (!isPlainObject(slots)) return false;
  for (const rel of RELATIONSHIP_NAMES) {
    if (!Array.isArray(slots[rel])) return false;
    for (const item of slots[rel]) {
      if (!isPlainObject(item)) return false;
      if (typeof item.token !== "string") return false;
      if (typeof item.w !== "number" || item.w < 0 || item.w > 1) return false;
    }
  }
  if (!isPlainObject(meta)) return false;
  if (meta.language !== "en" || meta.source !== "LLM") return false;
  if (typeof meta.downloaded_at !== "string") return false;
  return true;
}

export function validateRunLog(value) {
  if (!isPlainObject(value)) return false;
  const { id, inputPrompt, originalLLM, refined, emergentThoughts, steps, tokensIn, tokensOut } = value;
  if (typeof id !== "string" || typeof inputPrompt !== "string") return false;
  if (typeof originalLLM !== "string" || typeof refined !== "string") return false;
  if (typeof emergentThoughts !== "string") return false;
  if (!Array.isArray(steps)) return false;
  for (const step of steps) {
    if (!isPlainObject(step)) return false;
    if (typeof step.name !== "string" || typeof step.t0 !== "number" || typeof step.t1 !== "number") return false;
    if (typeof step.ok !== "boolean") return false;
    if ("note" in step && typeof step.note !== "string") return false;
  }
  if (!Array.isArray(tokensIn) || !Array.isArray(tokensOut)) return false;
  if (!tokensIn.every((t) => typeof t === "string")) return false;
  if (!tokensOut.every((t) => typeof t === "string")) return false;
  return true;
}
