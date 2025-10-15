import { RELATIONSHIP_NAMES } from "./relationships.js";

function simpleHash(input) {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function normalizeTokens(tokens) {
  return tokens
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

export function tokenizeWords(text) {
  if (!text) return [];
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const phrases = new Set(base);
  for (let i = 0; i < base.length; i++) {
    if (i + 1 < base.length) phrases.add(`${base[i]} ${base[i + 1]}`);
    if (i + 2 < base.length) phrases.add(`${base[i]} ${base[i + 1]} ${base[i + 2]}`);
  }
  return normalizeTokens(Array.from(phrases));
}

export function scoreCentrality(matrix) {
  const totals = {};
  let maxSlot = 0;
  let global = 0;
  for (const rel of RELATIONSHIP_NAMES) {
    const entries = matrix.slots?.[rel] || [];
    const sum = entries.reduce((acc, item) => acc + (item.w || 0), 0);
    totals[rel] = sum;
    if (sum > maxSlot) maxSlot = sum;
    global += sum;
  }
  const normalized = {};
  const denom = maxSlot || 1;
  for (const rel of RELATIONSHIP_NAMES) {
    normalized[rel] = Number((totals[rel] / denom).toFixed(4));
  }
  return {
    perSlot: normalized,
    total: Number(global.toFixed(4))
  };
}

export function formalizeHierarchy(matrices) {
  if (!Array.isArray(matrices)) return { layers: new Map(), stats: [] };
  const stats = matrices.map((matrix) => ({
    token: matrix.token,
    centrality: scoreCentrality(matrix).total
  }));
  const values = stats.map((s) => s.centrality).sort((a, b) => a - b);
  const quantile = (q) => {
    if (values.length === 0) return 0;
    const idx = Math.min(values.length - 1, Math.floor(q * (values.length - 1)));
    return values[idx];
  };
  const thresholds = {
    core: quantile(0.8),
    inner: quantile(0.5),
    outer: quantile(0.2)
  };
  const layers = new Map();
  for (const { token, centrality } of stats) {
    let layer = 3;
    if (centrality >= thresholds.core) layer = 0;
    else if (centrality >= thresholds.inner) layer = 1;
    else if (centrality >= thresholds.outer) layer = 2;
    layers.set(token, layer);
  }
  return { layers, stats, thresholds };
}

function selectNeighbors(matrix, fanout) {
  const neighbors = new Map();
  for (const rel of RELATIONSHIP_NAMES) {
    const entries = (matrix.slots?.[rel] || [])
      .slice()
      .sort((a, b) => b.w - a.w)
      .slice(0, fanout);
    neighbors.set(rel, entries.map((item) => ({ ...item })));
  }
  return neighbors;
}

export function crossLevelExpand(inputMats, outputMats, depth = 2, fanout = 5) {
  const matrices = new Map();
  for (const m of [...inputMats, ...outputMats]) matrices.set(m.token, m);
  const graph = new Map();
  const queue = [];
  for (const token of matrices.keys()) {
    queue.push({ token, depth: 0 });
  }
  const visited = new Set();
  while (queue.length) {
    const { token, depth: d } = queue.shift();
    if (visited.has(token) || d > depth) continue;
    visited.add(token);
    const matrix = matrices.get(token);
    if (!matrix) continue;
    const neighbors = selectNeighbors(matrix, fanout);
    graph.set(token, { token, neighbors, depth: d });
    if (d === depth) continue;
    for (const entries of neighbors.values()) {
      for (const entry of entries) {
        if (!visited.has(entry.token)) {
          queue.push({ token: entry.token, depth: d + 1 });
        }
      }
    }
  }
  return { graph, visited: Array.from(visited) };
}

export function dynamicReorg(graphState) {
  const { graph } = graphState;
  const reorganized = new Map();
  const now = Date.now();
  for (const [token, node] of graph.entries()) {
    const edges = [];
    for (const [rel, entries] of node.neighbors.entries()) {
      for (const entry of entries) {
        const base = entry.lastSeen ? now - entry.lastSeen : 1;
        const recency = 1 / (1 + Math.log10(1 + base));
        const score = Number((entry.w * recency).toFixed(4));
        edges.push({ token: entry.token, rel, score });
      }
    }
    edges.sort((a, b) => b.score - a.score);
    reorganized.set(token, { token, edges });
  }
  return { ...graphState, reorganized };
}

export function attentionEmbed(graphState) {
  const { reorganized } = graphState;
  const embeddings = new Map();
  for (const [token, node] of reorganized.entries()) {
    let total = 0;
    for (const edge of node.edges) total += edge.score;
    const value = total === 0 ? 0 : Math.tanh(total);
    embeddings.set(token, Number(value.toFixed(4)));
  }
  return { ...graphState, embeddings };
}

export function propagateNonLocal(graphState) {
  const { reorganized, embeddings } = graphState;
  const propagated = new Map();
  for (const [token, node] of reorganized.entries()) {
    const neighbors = node.edges;
    if (!neighbors.length) {
      propagated.set(token, embeddings.get(token) || 0);
      continue;
    }
    let sum = 0;
    for (const edge of neighbors) {
      sum += (embeddings.get(edge.token) || 0) * edge.score;
    }
    const value = sum / neighbors.length;
    propagated.set(token, Number(value.toFixed(4)));
  }
  return { ...graphState, propagated };
}

export function synthesizeEmergentThoughts(stepLogs) {
  if (!Array.isArray(stepLogs) || !stepLogs.length) return "- No new signals.";
  const bullets = [];
  for (const step of stepLogs) {
    if (!step.ok) continue;
    const duration = Math.max(0, Math.round(step.t1 - step.t0));
    const note = step.note ? ` — ${step.note}` : "";
    bullets.push(`- ${step.name} completed in ${duration}ms${note}`);
  }
  return bullets.length ? bullets.join("\n") : "- Signals inconclusive.";
}

export function reflectRewrite(original, emergentBullets) {
  const draftId = simpleHash(original + "|" + emergentBullets);
  return {
    draftId,
    payload: `Original answer:\n${original}\n\nSignals (emergent thoughts):\n${emergentBullets}\n\nRewrite the answer to be clearer, better-structured, and more complete. Keep it self-contained. Avoid revealing the internal analysis. Return plain text.`
  };
}
