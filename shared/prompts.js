export const MAIN_SYSTEM_PROMPT = "You are an LLM assistant that provides concise, accurate answers. When helpful, you may use technical detail. Avoid chain-of-thought exposition.";

export function buildMainMessages(userPrompt) {
  return [
    { role: "system", content: MAIN_SYSTEM_PROMPT },
    { role: "user", content: userPrompt }
  ];
}

export const REFLECT_SYSTEM_PROMPT = "You refine earlier answers using structured signals. You are brief, correct, and well-organized.";

export function buildReflectMessages(originalLLM, emergentBullets) {
  return [
    { role: "system", content: REFLECT_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Original answer:\n${originalLLM}\n\nSignals (emergent thoughts):\n${emergentBullets}\n\nRewrite the answer to be clearer, better-structured, and more complete. Keep it self-contained. Avoid revealing the internal analysis. Return plain text.`
    }
  ];
}
