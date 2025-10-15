import { RELATIONSHIP_NAMES } from "./relationships.js";

function simpleHash(input) {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function tokenizeWords(s) {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9'\- ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
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

export function bootstrapFromText(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 2) return [];
  const edges = new Map();
  const seqW = 0.7;
  const coW = 0.3;
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (!a || !b) continue;
    const key = `${a}|${b}`;
    edges.set(key, (edges.get(key) || 0) + seqW);
  }
  const window = 2;
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j <= i + window && j < tokens.length; j++) {
      const a = tokens[i];
      const b = tokens[j];
      if (!a || !b) continue;
      const key = `${a}|${b}`;
      edges.set(key, (edges.get(key) || 0) + coW / (j - i));
    }
  }
  return Array.from(edges.entries()).map(([key, weight]) => {
    const [a, b] = key.split("|");
    return { a, b, w: Math.min(1, weight) };
  });
}

export function integrateBootstrapEdges(graphState, bootstrapEdges) {
  if (!Array.isArray(bootstrapEdges) || !bootstrapEdges.length) return graphState;
  const reorganized = new Map(graphState.reorganized || []);
  for (const edge of bootstrapEdges) {
    if (!edge || !edge.a || !edge.b) continue;
    if (!reorganized.has(edge.a)) {
      reorganized.set(edge.a, { token: edge.a, edges: [] });
    }
    const node = reorganized.get(edge.a);
    const score = Number(edge.w || 0);
    node.edges.push({ token: edge.b, rel: "Sequence Of", score: Number(score.toFixed(4)) });
  }
  return { ...graphState, reorganized };
}

export function composeInsightGraph({
  matrices = [],
  hierarchyData = {},
  dynamicData = {},
  attentionData = {},
  propagationData = {}
} = {}) {
  const nodes = new Map();
  const edges = [];
  const layers = hierarchyData?.layers instanceof Map ? hierarchyData.layers : new Map();
  const centralityLookup = new Map();
  for (const matrix of matrices) {
    if (!matrix?.token) continue;
    centralityLookup.set(matrix.token, scoreCentrality(matrix).total);
  }
  const reorganized = dynamicData?.reorganized instanceof Map ? dynamicData.reorganized : new Map();
  for (const [token, node] of reorganized.entries()) {
    if (!nodes.has(token)) {
      nodes.set(token, {
        token,
        edges: [],
        centrality: 0,
        layer: layers.get(token) ?? 3,
        attention: 0,
        propagation: 0
      });
    }
    const entry = nodes.get(token);
    entry.edges = node.edges.map((edge) => ({
      token: edge.token,
      rel: edge.rel,
      score: Number(edge.score ?? 0)
    }));
    for (const edge of entry.edges) {
      edges.push({
        a: token,
        b: edge.token,
        w: edge.score,
        rel: edge.rel
      });
    }
  }
  const attention = attentionData?.embeddings instanceof Map ? attentionData.embeddings : new Map();
  const propagation = propagationData?.propagated instanceof Map ? propagationData.propagated : new Map();
  const allTokens = new Set([
    ...centralityLookup.keys(),
    ...reorganized.keys(),
    ...attention.keys(),
    ...propagation.keys()
  ]);
  for (const token of allTokens) {
    if (!nodes.has(token)) {
      nodes.set(token, {
        token,
        edges: [],
        centrality: 0,
        layer: layers.get(token) ?? 3,
        attention: 0,
        propagation: 0
      });
    }
    const entry = nodes.get(token);
    entry.centrality = Number(centralityLookup.get(token) ?? entry.centrality ?? 0);
    entry.layer = Number.isFinite(layers.get(token)) ? layers.get(token) : entry.layer ?? 3;
    entry.attention = Number(attention.get(token) ?? entry.attention ?? 0);
    entry.propagation = Number(propagation.get(token) ?? entry.propagation ?? 0);
  }
  return {
    nodes: Array.from(nodes.values()).map((node) => ({
      ...node,
      centrality: Number(node.centrality ?? 0),
      attention: Number(node.attention ?? 0),
      propagation: Number(node.propagation ?? 0),
      layer: Number.isFinite(node.layer) ? node.layer : 3
    })),
    edges
  };
}

export function rankByCentrality(graph) {
  if (!graph) return [];
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  return nodes
    .map((node) => ({
      token: node.token,
      score:
        Number(node.centrality ?? 0) +
        0.5 * Number(node.attention ?? 0) +
        0.25 * Number(node.propagation ?? 0)
    }))
    .filter((entry) => entry.token)
    .sort((a, b) => b.score - a.score);
}

export function findTopBridges(graph) {
  if (!graph) return [];
  const layerMap = new Map();
  for (const node of graph.nodes || []) {
    layerMap.set(node.token, Number.isFinite(node.layer) ? node.layer : 3);
  }
  const edges = (graph.edges || []).map((edge) => {
    const layerGap = Math.abs((layerMap.get(edge.a) ?? 3) - (layerMap.get(edge.b) ?? 3));
    return {
      a: edge.a,
      b: edge.b,
      w: Number(edge.w ?? 0),
      layerGap,
      score: layerGap * 2 + Number(edge.w ?? 0)
    };
  });
  return edges
    .filter((edge) => edge.a && edge.b)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

export function countLayerMoves(graph) {
  if (!graph) return 0;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  return nodes.filter((node) => (node.layer ?? 3) <= 1).length;
}

export function suggestNext(graph) {
  if (!graph) return [];
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  return nodes
    .map((node) => ({
      token: node.token,
      value: Number(node.propagation ?? 0) - 0.3 * Number(node.centrality ?? 0)
    }))
    .filter((entry) => entry.token)
    .sort((a, b) => b.value - a.value)
    .map((entry) => entry.token);
}

export function synthesizeEmergentThoughts(graph) {
  const top = rankByCentrality(graph).slice(0, 3).map((x) => x.token);
  const bridges = findTopBridges(graph).slice(0, 2).map((edge) => `${edge.a}↔${edge.b}`);
  const bullets = [];
  if (top.length) bullets.push(`Core topics converging: ${top.join(", ")}`);
  if (bridges.length) bullets.push(`Bridging links: ${bridges.join("; ")}`);
  bullets.push(`Layer reorg: ${countLayerMoves(graph)} tokens shifted upward`);
  bullets.push(`Attention focus rising on: ${top[0] || "—"}`);
  const next = suggestNext(graph).slice(0, 3);
  bullets.push(`Next expansions suggested: ${next.length ? next.join(", ") : "—"}`);
  while (bullets.length < 5) {
    bullets.push("Signal pending expansion: —");
  }
  return bullets;
}

export function formatRunReport(stepLogs) {
  if (!Array.isArray(stepLogs) || !stepLogs.length) return "No steps recorded.";
  const lines = [];
  for (const step of stepLogs) {
    const duration = Math.max(0, Math.round((step.t1 ?? step.t0 ?? 0) - (step.t0 ?? 0)));
    const status = step.ok ? "✔" : "✖";
    const note = step.note ? ` — ${step.note}` : "";
    lines.push(`${status} ${step.name} (${duration}ms)${note}`);
  }
  return lines.join("\n");
}

export function reflectRewrite(original, emergentBullets) {
  const bulletText = Array.isArray(emergentBullets)
    ? emergentBullets.map((b) => `- ${b}`).join("\n")
    : String(emergentBullets || "");
  const draftId = simpleHash(original + "|" + bulletText);
  return {
    draftId,
    payload: `Original answer:\n${original}\n\nSignals (emergent thoughts):\n${bulletText}\n\nRewrite the answer to be clearer, better-structured, and more complete. Keep it self-contained. Avoid revealing the internal analysis. Return plain text.`
  };
}
