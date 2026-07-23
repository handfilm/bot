/**
 * ==========================================================================
 * Multi-AI Chatbot Backend — Claude + Gemini + Grok, one unified endpoint
 * ==========================================================================
 *
 * WHAT THIS IS
 * A single Cloudflare Worker that your website calls. It holds all three
 * API keys as encrypted secrets (never exposed to the browser) and:
 *   1. Routes each message to the best provider (auto mode) OR respects
 *      an explicit ?provider= choice from the widget
 *   2. Falls back Claude -> Gemini -> Grok -> friendly error if a provider
 *      is down or errors out
 *   3. Streams the response back token-by-token (Server-Sent Events)
 *   4. Adding a 4th/5th provider later = write one more adapter function
 *      + one more line in PROVIDERS. Nothing else changes.
 *
 * DEPLOY (from your phone, no local Node needed):
 *   1. https://dash.cloudflare.com -> Workers & Pages -> Create -> Worker
 *   2. Name it e.g. "multi-ai-bot" -> Deploy -> Edit code -> paste this file
 *   3. Settings -> Variables and Secrets -> add THREE encrypted secrets:
 *        ANTHROPIC_API_KEY   = <your Anthropic key>
 *        GEMINI_API_KEY      = <your Google AI Studio / Gemini key>
 *        XAI_API_KEY         = <your xAI / Grok key>
 *   4. Settings -> Variables and Secrets -> add ONE plain variable:
 *        ALLOWED_ORIGIN      = https://yourdomain.com
 *   5. Save & deploy. Your endpoint:
 *        https://multi-ai-bot.<your-subdomain>.workers.dev
 *   6. Point widget/chat-widget.js's ENDPOINT at that URL.
 *
 * You only need the keys for the providers you actually want live. If e.g.
 * XAI_API_KEY is never set, Grok is skipped automatically (see isConfigured).
 * ==========================================================================
 */

// ---------------------------------------------------------------------------
// Provider registry — add a new provider by adding one adapter + one entry
// ---------------------------------------------------------------------------
const PROVIDERS = {
  claude: {
    label: "Claude (Anthropic)",
    isConfigured: (env) => !!env.ANTHROPIC_API_KEY,
    call: callClaude,
    strengths: ["reasoning", "writing", "careful/safe replies", "long conversation"],
  },
  gemini: {
    label: "Gemini (Google)",
    isConfigured: (env) => !!env.GEMINI_API_KEY,
    call: callGemini,
    strengths: ["images/documents", "very long context", "multimodal"],
  },
  grok: {
    label: "Grok (xAI)",
    isConfigured: (env) => !!env.XAI_API_KEY,
    call: callGrok,
    strengths: ["current events", "fast + cheap", "casual tone"],
  },
};

// Default fallback order if the caller doesn't pick a provider and auto-routing
// doesn't confidently match a category.
const DEFAULT_ORDER = ["claude", "gemini", "grok"];

// Model IDs — kept in one place so upgrading is a one-line change per provider.
const MODEL_IDS = {
  claude: "claude-sonnet-4-6",
  gemini: "gemini-3.5-flash",
  grok: "grok-4.1-fast",
};

// ---------------------------------------------------------------------------
// Very small keyword-based auto-router. Cheap, fast, no extra API call.
// Swap this out later for an LLM-based classifier if you want smarter routing.
// ---------------------------------------------------------------------------
function autoRoute(lastUserMessage) {
  const text = (lastUserMessage || "").toLowerCase();

  if (/(today|latest|current|breaking|news|right now|this week|price of|score)/.test(text)) {
    return "grok"; // needs current/live info
  }
  if (/(image|photo|picture|pdf|document|attached|analyze this file|video)/.test(text)) {
    return "gemini"; // multimodal-heavy
  }
  return "claude"; // default: reasoning/writing/general
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
function corsHeaders(env, origin) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  const allowOrigin = allowed === "*" ? "*" : (origin === allowed ? allowed : allowed);
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ---------------------------------------------------------------------------
// Provider adapters — each returns { text } for non-streaming,
// or writes SSE chunks directly to the passed `writer` for streaming.
// ---------------------------------------------------------------------------

async function callClaude(env, messages, { stream, writer, system }) {
  const anthropicMessages = messages.map((m) => ({ role: m.role, content: m.content }));

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL_IDS.claude,
      max_tokens: 800,
      system,
      messages: anthropicMessages,
      stream: !!stream,
    }),
  });

  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);

  if (!stream) {
    const data = await res.json();
    const text = data.content?.find((b) => b.type === "text")?.text || "";
    return { text };
  }

  // Anthropic SSE: content_block_delta events carry .delta.text
  await pipeSse(res, writer, (event) => {
    if (event.type === "content_block_delta" && event.delta?.text) return event.delta.text;
    return null;
  });
  return null;
}

async function callGemini(env, messages, { stream, writer, system }) {
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const method = stream ? "streamGenerateContent" : "generateContent";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_IDS.gemini}:${method}?key=${env.GEMINI_API_KEY}${stream ? "&alt=sse" : ""}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig: { maxOutputTokens: 800 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);

  if (!stream) {
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    return { text };
  }

  await pipeSse(res, writer, (event) => {
    const t = event.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
    return t || null;
  });
  return null;
}

async function callGrok(env, messages, { stream, writer, system }) {
  const grokMessages = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL_IDS.grok,
      messages: grokMessages,
      max_tokens: 800,
      stream: !!stream,
    }),
  });

  if (!res.ok) throw new Error(`Grok API ${res.status}: ${await res.text()}`);

  if (!stream) {
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";
    return { text };
  }

  // Grok/xAI uses OpenAI-style SSE: choices[0].delta.content
  await pipeSse(res, writer, (event) => {
    return event.choices?.[0]?.delta?.content || null;
  });
  return null;
}

// ---------------------------------------------------------------------------
// Shared SSE pump: reads an upstream SSE/JSON-lines response, extracts text
// via `extractFn`, and forwards it downstream as our own SSE `token` events.
// ---------------------------------------------------------------------------
async function pipeSse(upstreamRes, writer, extractFn) {
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete last line for next chunk

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const event = JSON.parse(payload);
        const text = extractFn(event);
        if (text) await writer.write(new TextEncoder().encode(`data: ${JSON.stringify({ token: text })}\n\n`));
      } catch {
        // ignore malformed/partial lines
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fallback chain: try providers in order until one succeeds
// ---------------------------------------------------------------------------
async function runWithFallback(env, messages, opts, orderedProviders) {
  const errors = [];
  for (const name of orderedProviders) {
    const provider = PROVIDERS[name];
    if (!provider || !provider.isConfigured(env)) continue;
    try {
      const result = await provider.call(env, messages, opts);
      return { providerUsed: name, ...result };
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
      // try next provider
    }
  }
  throw new Error(`All providers failed or unconfigured -> ${errors.join(" | ")}`);
}

const SYSTEM_PROMPT = `You are a helpful assistant embedded on a business website.
Be concise, friendly, and accurate. If you don't know something current, say so
rather than guessing. Keep replies under 120 words unless the user asks for more detail.`;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(env, origin);

    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const { messages = [], provider, stream = false, system } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages[] required" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
    const chosen = provider && PROVIDERS[provider] ? provider : autoRoute(lastUser);
    const order = [chosen, ...DEFAULT_ORDER.filter((p) => p !== chosen)];

    // ---------------- non-streaming ----------------
    if (!stream) {
      try {
        const result = await runWithFallback(env, messages, { stream: false, system: system || SYSTEM_PROMPT }, order);
        return new Response(JSON.stringify(result), {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
    }

    // ---------------- streaming (SSE) ----------------
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    (async () => {
      try {
        const providerUsed = order.find((name) => PROVIDERS[name]?.isConfigured(env));
        await writer.write(new TextEncoder().encode(`data: ${JSON.stringify({ providerUsed })}\n\n`));
        await runWithFallback(env, messages, { stream: true, writer, system: system || SYSTEM_PROMPT }, order);
      } catch (err) {
        await writer.write(new TextEncoder().encode(`data: ${JSON.stringify({ error: err.message })}\n\n`));
      } finally {
        await writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  },
};
