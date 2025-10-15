#!/usr/bin/env node
import readline from "node:readline";
import process from "node:process";

import { streamChat, getAdjMatrix } from "./llm.js";
import { loadMatrix, saveMatrix, listTokens, exportAll } from "./storage.js";
import {
  tokenizeWords,
  formalizeHierarchy,
  crossLevelExpand,
  dynamicReorg,
  attentionEmbed,
  propagateNonLocal,
  synthesizeEmergentThoughts,
  reflectRewrite,
  scoreCentrality
} from "../shared/engine.js";
import { validateAdjacencyMatrix } from "../shared/schema.js";
import { buildMainMessages, REFLECT_SYSTEM_PROMPT } from "../shared/prompts.js";

const spinnerFrames = ["|", "/", "-", "\\"];
let MODEL = process.env.MODEL || "gpt-4o-mini";
let DEPTH = 2;
let FANOUT = 5;
let API_KEY = process.env.OPENAI_API_KEY || null;
let lastOriginal = "";
let lastThoughts = "";
let lastRefined = "";

function printHelp() {
  console.log(`Commands:\n  model <name>     -> set model (current: ${MODEL})\n  depth <n>        -> set expansion depth (current: ${DEPTH})\n  fanout <k>       -> set per-slot fanout (current: ${FANOUT})\n  ls matrices      -> list cached tokens\n  open <TOKEN>     -> open token's matrix\n  export           -> write matrices/export.json\n  toggle original  -> show or hide last original output\n  toggle thoughts  -> show or hide last emergent thoughts\n  help             -> show this help\nAny other input runs the HLSF pipeline.`);
}

function askForKey() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.stdoutMuted = false;
    rl._writeToOutput = function _writeToOutput(str) {
      if (rl.stdoutMuted) {
        if (str.includes("\n")) {
          rl.output.write(str);
        }
        return;
      }
      rl.output.write(str);
    };
    rl.question("Enter OpenAI API key: ", (key) => {
      rl.close();
      console.log("\nAPI key stored in memory for this session.");
      resolve(key.trim());
    });
    rl.stdoutMuted = true;
  });
}

function clearLine() {
  process.stdout.write("\r" + " ".repeat(80) + "\r");
}

async function runStep(name, fn, logs) {
  const start = Date.now();
  let frame = 0;
  let note = "";
  let active = true;
  const interval = setInterval(() => {
    if (!active) return;
    const elapsed = Date.now() - start;
    process.stdout.write(`\r${spinnerFrames[frame]} ${name}... ${elapsed}ms`);
    frame = (frame + 1) % spinnerFrames.length;
  }, 120);
  const state = {
    update(msg) {
      note = msg;
    }
  };
  try {
    const result = await fn(state);
    if (typeof result === "string") note = result;
    active = false;
    clearInterval(interval);
    clearLine();
    const end = Date.now();
    console.log(`✔ ${name} (${end - start}ms)${note ? ` - ${note}` : ""}`);
    const entry = { name, t0: start, t1: end, ok: true, note };
    logs.push(entry);
    return entry;
  } catch (err) {
    active = false;
    clearInterval(interval);
    clearLine();
    const end = Date.now();
    const msg = err?.message || "Unknown error";
    console.log(`✖ ${name} (${end - start}ms) - ${msg}`);
    const entry = { name, t0: start, t1: end, ok: false, note: msg };
    logs.push(entry);
    throw err;
  }
}

async function runStreamingStep(name, factory, logs) {
  const start = Date.now();
  let frame = 0;
  let spinning = true;
  const interval = setInterval(() => {
    if (!spinning) return;
    const elapsed = Date.now() - start;
    process.stdout.write(`\r${spinnerFrames[frame]} ${name}... ${elapsed}ms`);
    frame = (frame + 1) % spinnerFrames.length;
  }, 120);
  try {
    const iterator = await factory();
    spinning = false;
    clearInterval(interval);
    clearLine();
    console.log(`↘ ${name} (streaming)`);
    let text = "";
    for await (const chunk of iterator) {
      text += chunk;
      process.stdout.write(chunk);
    }
    console.log();
    const end = Date.now();
    console.log(`✔ ${name} (${end - start}ms) - ${text.length} chars`);
    const entry = { name, t0: start, t1: end, ok: true, note: `${text.length} chars` };
    logs.push(entry);
    return { text, entry };
  } catch (err) {
    spinning = false;
    clearInterval(interval);
    clearLine();
    const end = Date.now();
    const msg = err?.message || "Unknown error";
    console.log(`✖ ${name} (${end - start}ms) - ${msg}`);
    const entry = { name, t0: start, t1: end, ok: false, note: msg };
    logs.push(entry);
    throw err;
  }
}

async function fetchMatrices(tokens, label, logs) {
  const matrices = [];
  const unique = Array.from(new Set(tokens));
  await runStep(label, async (state) => {
    let downloaded = 0;
    let cached = 0;
    state.update(`0 downloaded, 0 cached`);
    for (const token of unique) {
      const cachedMatrix = loadMatrix(token);
      if (cachedMatrix && validateAdjacencyMatrix(cachedMatrix)) {
        matrices.push(cachedMatrix);
        cached++;
        console.log(`  • ${token} (loaded from cache)`);
        continue;
      }
      const matrix = await getAdjMatrix({ apiKey: API_KEY, model: MODEL, token });
      if (!validateAdjacencyMatrix(matrix)) {
        throw new Error(`Invalid adjacency matrix for ${token}`);
      }
      saveMatrix(matrix);
      matrices.push(matrix);
      downloaded++;
      console.log(`  • ${token} (downloaded)`);
      state.update(`${downloaded} downloaded, ${cached} cached`);
    }
    state.update(`${downloaded} downloaded, ${cached} cached`);
  }, logs);
  return matrices;
}

async function openToken(token) {
  if (!token) {
    console.log("Token required (open <TOKEN>)." );
    return;
  }
  if (!API_KEY) {
    API_KEY = await askForKey();
  }
  const matrix = loadMatrix(token);
  if (!matrix) {
    console.log(`No cached matrix for "${token}". Fetching...`);
    try {
      const fresh = await getAdjMatrix({ apiKey: API_KEY, model: MODEL, token });
      if (!validateAdjacencyMatrix(fresh)) throw new Error("Schema mismatch");
      saveMatrix(fresh);
      console.log(JSON.stringify(fresh, null, 2));
    } catch (err) {
      console.log(`Failed to download matrix: ${err.message}`);
    }
    return;
  }
  console.log(JSON.stringify(matrix, null, 2));
}

async function runPipeline(prompt) {
  if (!API_KEY) {
    API_KEY = await askForKey();
  }
  const logs = [];
  const tokensIn = tokenizeWords(prompt);
  await runStep(
    "Tokenizing prompt input",
    () => `${tokensIn.length} tokens`,
    logs
  );
  const inputMatrices = await fetchMatrices(tokensIn, "Downloading LLM input token weights and adjacencies", logs);
  const { text: originalLLM } = await runStreamingStep(
    "Loading LLM response to prompt",
    async () => {
      const stream = await streamChat({ apiKey: API_KEY, model: MODEL, messages: buildMainMessages(prompt) });
      return stream;
    },
    logs
  );
  lastOriginal = originalLLM;
  const tokensOut = tokenizeWords(originalLLM);
  await runStep("Tokenizing LLM response output", () => `${tokensOut.length} tokens`, logs);
  const outputMatrices = await fetchMatrices(tokensOut, "Downloading LLM output token weights and adjacencies", logs);
  await runStep("Loading input tokens into HLSF matrices", () => `${inputMatrices.length} matrices`, logs);
  await runStep("Loading output tokens into HLSF matrices", () => `${outputMatrices.length} matrices`, logs);
  const combinedMatrices = [...inputMatrices, ...outputMatrices];
  let hierarchyData;
  await runStep("Formalizing hierarchical adjacencies", () => {
    hierarchyData = formalizeHierarchy(combinedMatrices);
    const core = Array.from(hierarchyData.layers.entries()).filter(([, layer]) => layer === 0).length;
    return `${core} core tokens`;
  }, logs);
  let crossData;
  await runStep("Initiating cross-level recursive expansions", () => {
    crossData = crossLevelExpand(inputMatrices, outputMatrices, DEPTH, FANOUT);
    return `${crossData.visited.length} tokens traversed`;
  }, logs);
  let dynamicData;
  await runStep("Dynamically reorganizing knowledge at multiple abstraction layers", () => {
    dynamicData = dynamicReorg(crossData);
    const totalEdges = Array.from(dynamicData.reorganized.values()).reduce((acc, node) => acc + node.edges.length, 0);
    return `${totalEdges} edges ranked`;
  }, logs);
  let attentionData;
  await runStep("Deploying attention-driven embedding algorithms", () => {
    attentionData = attentionEmbed(dynamicData);
    const mean = Array.from(attentionData.embeddings.values()).reduce((acc, val) => acc + val, 0) / (attentionData.embeddings.size || 1);
    return `mean activation ${mean.toFixed(3)}`;
  }, logs);
  await runStep("Facilitating efficient hierarchical knowledge synthesis", () => {
    const summary = `layers=${hierarchyData.layers.size}, traversed=${crossData.visited.length}`;
    return summary;
  }, logs);
  let propagationData;
  await runStep("Propagating non-local information", () => {
    propagationData = propagateNonLocal(attentionData);
    const avg = Array.from(propagationData.propagated.values()).reduce((acc, val) => acc + val, 0) / (propagationData.propagated.size || 1);
    return `avg signal ${avg.toFixed(3)}`;
  }, logs);
  const centralities = combinedMatrices.map((m) => ({ token: m.token, centrality: scoreCentrality(m).total }));
  await runStep("Logging emergent thought stream", () => {
    lastThoughts = synthesizeEmergentThoughts(logs);
    return `${centralities.length} tokens analyzed`;
  }, logs);
  const reflectData = reflectRewrite(lastOriginal, lastThoughts);
  const { text: refined } = await runStreamingStep(
    "Developing revised response output",
    async () => {
      const messages = [
        { role: "system", content: REFLECT_SYSTEM_PROMPT },
        { role: "user", content: reflectData.payload }
      ];
      const stream = await streamChat({ apiKey: API_KEY, model: MODEL, messages });
      return stream;
    },
    logs
  );
  lastRefined = refined;
  console.log("Refined response ready. Type 'toggle original' or 'toggle thoughts' to inspect.");
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("HLSF Lite CLI. Type 'help' for commands.");
  if (!API_KEY) {
    console.log("No API key detected. It will be requested before the first prompt.");
  }
  function promptNext() {
    rl.question("> ", async (line) => {
      const trimmed = line.trim();
      try {
        if (!trimmed) {
          promptNext();
          return;
        }
        if (trimmed.startsWith("model ")) {
          MODEL = trimmed.slice(6).trim();
          console.log(`Model set to ${MODEL}.`);
        } else if (trimmed.startsWith("depth ")) {
          const value = Number.parseInt(trimmed.slice(6).trim(), 10);
          if (Number.isFinite(value) && value > 0) {
            DEPTH = value;
            console.log(`Depth set to ${DEPTH}.`);
          } else {
            console.log("Depth must be a positive integer.");
          }
        } else if (trimmed.startsWith("fanout ")) {
          const value = Number.parseInt(trimmed.slice(7).trim(), 10);
          if (Number.isFinite(value) && value > 0) {
            FANOUT = value;
            console.log(`Fanout set to ${FANOUT}.`);
          } else {
            console.log("Fanout must be a positive integer.");
          }
        } else if (trimmed === "help") {
          printHelp();
        } else if (trimmed === "ls matrices") {
          const tokens = listTokens();
          if (!tokens.length) console.log("No matrices cached yet.");
          else tokens.forEach((t) => console.log(`- ${t}`));
        } else if (trimmed.startsWith("open ")) {
          const token = trimmed.slice(5).trim();
          await openToken(token);
        } else if (trimmed === "export") {
          const file = exportAll();
          console.log(`Matrices exported to ${file}.`);
        } else if (trimmed === "toggle original") {
          if (!lastOriginal) console.log("No original output yet.");
          else console.log(`--- Original LLM Output ---\n${lastOriginal}\n---------------------------`);
        } else if (trimmed === "toggle thoughts") {
          if (!lastThoughts) console.log("No emergent thoughts yet.");
          else console.log(`--- Emergent Thoughts ---\n${lastThoughts}\n-------------------------`);
        } else {
          await runPipeline(trimmed);
          if (lastRefined) {
            console.log(`--- Refined Response ---\n${lastRefined}\n------------------------`);
          }
        }
      } catch (err) {
        console.log(`Error: ${err.message}`);
      } finally {
        promptNext();
      }
    });
  }
  promptNext();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
