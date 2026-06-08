// safeParseLLM — robust JSON parser for LLM output.
// Self-contained: just safeParseLLM + its one dependency (extractJSON). 
// No npm deps, no imports.
//
// Why this exists: LLMs that are told "return ONLY valid JSON" still emit
// markdown fences, smart-quote/zero-width junk, raw newlines inside string
// values, trailing commas, and prose preambles. JSON.parse() dies on all of it.
// This runs a 5-step recovery cascade and only throws if every step fails.
//
// HANDLES:    markdown ```json fences, zero-width/nbsp chars, control chars,
//             raw \n inside string values, trailing commas, prose before/after
//             the JSON, and complete-but-messy objects/arrays.
// DOES *NOT*: reliably recover token-limit TRUNCATION (output cut off mid-object
//             with unclosed braces). extractJSON attempts a close-the-stack
//             repair but it mangles the final key/value often enough that you
//             should NOT rely on it. If you expect truncation (large outputs
//             near max_tokens), pair this with a dedicated bracket-balancer, or
//             better, raise max_tokens / ask the model to be terser. For
//             truncation handling, consider a separate inline balancer or
//             increase token limits upstream.
//
// Usage:
//   import { safeParseLLM } from './safeParseLLM.js';
//   const obj = safeParseLLM(claudeResponseText, 'object', 'my-feature');
//   const arr = safeParseLLM(claudeResponseText, 'array',  'my-feature');
//
//   - type:   'object' (default) | 'array' — what shape you expect back.
//   - caller: a string tag for log attribution (which feature called it).
//
// Behavior: returns the parsed value, or throws
// `Error('LLM JSON parse failed after recovery')` if all 5 steps fail. Steps
// 3-5 log a console.warn so you can see in prod when a prompt is drifting
// toward malformed output (each recovery is a signal the upstream prompt
// could be tightened).
//
// CommonJS? Swap the two `export` keywords for `module.exports = { ... }`.

// ── extractJSON — pull the first balanced {...} or [...] out of a blob ───────
// Depth-counts braces/brackets. If the structure is truncated (LLM hit the
// token cap mid-object), it closes the open structures and returns the
// repaired slice. Returns null if no opening delimiter is found.
export function extractJSON(text, type = 'object') {
  const open = type === 'array' ? '[' : '{';
  const close = type === 'array' ? ']' : '}';
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // JSON was truncated (hit token limit) — attempt recovery by closing open structures
  if (depth > 0) {
    let partial = text.slice(start).trimEnd();
    // Remove any trailing incomplete string or value
    partial = partial.replace(/,\s*$/, '').replace(/"[^"]*$/, '"truncated"');
    // Close all open braces/brackets
    const stack = [];
    for (const ch of partial) {
      if (ch === '{') stack.push('}');
      else if (ch === '[') stack.push(']');
      else if (ch === '}' || ch === ']') stack.pop();
    }
    partial += stack.reverse().join('');
    try { JSON.parse(partial); return partial; } catch(e) { /* unrecoverable */ }
  }
  return null;
}

// A practical solution to messy LLM output parsing.
// ── Shared LLM JSON parser — sanitise + recover ──────────────────────────────
export function safeParseLLM(raw, type = 'object', caller = 'unknown') {
  const stripped = raw
    .replace(/```(?:json)?\s*/g, '')
    .replace(/[\uFEFF\u200B\u200C\u200D\u2060\u00A0]/g, "")
    .trim();
  const extracted = extractJSON(stripped, type) || stripped;
  // Step 2: fast path
  try { return JSON.parse(extracted); } catch(_) {}
  // Step 3: control chars + trailing commas
  try {
    const sanitized = extracted
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
      .replace(/(?<!\\)\n(?=(?:[^"]*"[^"]*")*[^"]*"[^"]*$)/g, '\\n')
      .replace(/,\s*([\]\}])/g, '$1');
    const result = JSON.parse(sanitized);
    console.warn('[safeParseLLM] Step 3 recovery (' + caller + ') control chars/trailing commas');
    return result;
  } catch(_) {}
  // Step 4: brute-force
  try {
    const brute = extracted
      .replace(/\r/g, '')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/[\x00-\x1f]/g, ' ')
      .replace(/,\s*([\]\}])/g, '$1')
      .replace(/("\s*)(\n\s*")/g, '$1,$2')
      .replace(/(\}\s*)(\{)/g, '$1,$2')
      .replace(/("\s*)(\{)/g, '$1,$2')
      .replace(/(\}\s*)(")/g, '$1,$2')
      .replace(/([\]\}])\s*([\[\{])/g, '$1,$2')
      .replace(/(")\s*(")/g, '$1,$2');
    const result = JSON.parse(brute);
    console.warn('[safeParseLLM] Step 4 recovery (' + caller + ') brute-force escape');
    return result;
  } catch(_) {}
  // Step 5: nuclear
  try {
    const open = type === 'array' ? '[' : '{';
    const close = type === 'array' ? ']' : '}';
    const first = stripped.indexOf(open);
    const last = stripped.lastIndexOf(close);
    if (first !== -1 && last > first) {
      const sliced = stripped.slice(first, last + 1)
        .replace(/[\x00-\x1f]/g, ' ')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '')
        .replace(/\t/g, '\\t')
        .replace(/,\s*([\]\}])/g, '$1');
      const result = JSON.parse(sliced);
      console.warn('[safeParseLLM] NUCLEAR Step 5 recovery (' + caller + ') prompt is broken. First 80: ' + stripped.slice(0, 80).replace(/\n/g, ' '));
      return result;
    }
  } catch(_) {}
  console.error('[safeParseLLM] TOTAL FAILURE (' + caller + ') First 300:', stripped.slice(0, 300));
  throw new Error('LLM JSON parse failed after recovery');
}
