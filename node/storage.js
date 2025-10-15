import fs from "node:fs";
import path from "node:path";

import { canonToken } from "../shared/engine.js";

const ROOT = path.resolve(process.cwd(), "matrices");
const INDEX_FILE = path.join(ROOT, "index.json");

function ensureDir() {
  if (!fs.existsSync(ROOT)) {
    fs.mkdirSync(ROOT, { recursive: true });
  }
}

function normalizeToken(token) {
  const canon = canonToken(token);
  if (canon) return canon;
  return String(token || "").toLowerCase().trim();
}

function slugify(token) {
  const normalized = normalizeToken(token);
  return normalized.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function loadMatrix(token) {
  ensureDir();
  const normalized = normalizeToken(token);
  if (!normalized) return null;
  const slug = slugify(normalized);
  const file = path.join(ROOT, `${slug}.json`);
  if (!fs.existsSync(file)) return null;
  return readJSON(file);
}

export function saveMatrix(matrix) {
  ensureDir();
  const normalizedToken = normalizeToken(matrix.token);
  if (normalizedToken) {
    matrix.token = normalizedToken;
  }
  if (!matrix.meta) {
    matrix.meta = { language: "en", downloaded_at: new Date().toISOString(), source: "LLM" };
  } else if (!matrix.meta.downloaded_at) {
    matrix.meta.downloaded_at = new Date().toISOString();
  }
  const slug = slugify(matrix.token);
  const file = path.join(ROOT, `${slug}.json`);
  writeJSON(file, matrix);
  const index = readJSON(INDEX_FILE) || [];
  if (!index.includes(matrix.token)) {
    index.push(matrix.token);
    writeJSON(INDEX_FILE, index);
  }
  return file;
}

export function listTokens() {
  ensureDir();
  const index = readJSON(INDEX_FILE) || [];
  return index.slice().sort();
}

export function exportAll(dest = path.join(ROOT, "export.json")) {
  ensureDir();
  const tokens = listTokens();
  const bundle = {};
  for (const token of tokens) {
    const matrix = loadMatrix(token);
    if (matrix) bundle[token] = matrix;
  }
  writeJSON(dest, bundle);
  return dest;
}

export function deleteMatrix(token) {
  ensureDir();
  const normalized = normalizeToken(token);
  if (!normalized) return;
  const slug = slugify(normalized);
  const file = path.join(ROOT, `${slug}.json`);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
  const index = readJSON(INDEX_FILE) || [];
  const next = index.filter((t) => t !== normalized);
  if (next.length !== index.length) {
    writeJSON(INDEX_FILE, next);
  }
}
