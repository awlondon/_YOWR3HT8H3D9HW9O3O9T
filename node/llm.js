const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

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
  const sys = "You produce adjacency matrices for tokens as strict JSON per the provided schema. Tokens are words/phrases (not BPE). Weight scale: 0..1 floats. All 50 relationship slots must be present (empty arrays allowed). No extra keys.";
  const user = `token="${token}". Return schema-conforming JSON only.`;
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ],
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`OpenAI error: ${res.status}`);
    error.body = text;
    throw error;
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "{}";
  const matrix = JSON.parse(text);
  if (!matrix.meta) matrix.meta = { language: "en", downloaded_at: new Date().toISOString(), source: "LLM" };
  else if (!matrix.meta.downloaded_at) matrix.meta.downloaded_at = new Date().toISOString();
  return matrix;
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
