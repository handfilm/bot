/**
 * ==========================================================================
 * RAWx BOT Backend — Claude + Gemini + Grok + persistent conversation memory
 * ==========================================================================
 *
 * STEP 1 OF 4 (Memory > Upload > Search > Generate) — this file adds:
 *   - Multiple named conversations per browser (via a client-generated
 *     sessionId stored in localStorage)
 *   - Conversation history persisted in Cloudflare KV (binding: CHAT_KV)
 *   - New routes:
 *       GET    /api/conversations?sessionId=...          -> list conversations
 *       GET    /api/conversations/:id?sessionId=...       -> load one conversation
 *       DELETE /api/conversations/:id?sessionId=...        -> delete one conversation
 *       POST   /   (unchanged path, extended body)         -> chat, now also saves
 *
 * DEPLOY:
 *   1. Create a KV namespace "RAWX_BOT_KV" in the Cloudflare dashboard.
 *   2. Bind it to this Worker as CHAT_KV (Settings -> Bindings -> Add -> KV).
 *   3. Paste this whole file into Edit Code, then Deploy.
 * ==========================================================================
 */

// ---------------------------------------------------------------------------
// Provider registry
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

const DEFAULT_ORDER = ["claude", "gemini", "grok"];

const MODEL_IDS = {
  claude: "claude-sonnet-4-6",
  gemini: "gemini-3.5-flash",
  grok: "grok-4.1-fast",
};

// Cap how many conversations we keep per session, and how many messages per
// conversation, so KV storage never grows unbounded on the free tier.
const MAX_CONVERSATIONS_PER_SESSION = 50;
const MAX_MESSAGES_PER_CONVERSATION = 200;

// ---------------------------------------------------------------------------
// Auto-router
// ---------------------------------------------------------------------------
function autoRoute(lastUserMessage) {
  const text = (lastUserMessage || "").toLowerCase();
  if (/(today|latest|current|breaking|news|right now|this week|price of|score)/.test(text)) {
    return "grok";
  }
  if (/(image|photo|picture|pdf|document|attached|analyze this file|video)/.test(text)) {
    return "gemini";
  }
  return "claude";
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
function corsHeaders(env, origin) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  const allowOrigin = allowed === "*" ? "*" : allowed;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// KV helpers — conversation memory
// ---------------------------------------------------------------------------
function listKey(sessionId) {
  return `list:${sessionId}`;
}
function convKey(sessionId, conversationId) {
  return `conv:${sessionId}:${conversationId}`;
}

async function getConversationList(env, sessionId) {
  const raw = await env.CHAT_KV.get(listKey(sessionId));
  return raw ? JSON.parse(raw) : [];
}

async function saveConversationList(env, sessionId, list) {
  const trimmed = list
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS_PER_SESSION);
  await env.CHAT_KV.put(listKey(sessionId), JSON.stringify(trimmed));
}

async function getConversation(env, sessionId, conversationId) {
  const raw = await env.CHAT_KV.get(convKey(sessionId, conversationId));
  return raw ? JSON.parse(raw) : null;
}

function makeTitle(messages) {
  const firstUser = messages.find((m) => m.role === "user");
  const text = (firstUser?.content || "New conversation").trim();
  return text.length > 48 ? text.slice(0, 48) + "…" : text || "New conversation";
}

async function saveConversation(env, sessionId, conversationId, messages) {
  const trimmedMessages = messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
  const updatedAt = Date.now();

  await env.CHAT_KV.put(
    convKey(sessionId, conversationId),
    JSON.stringify({ id: conversationId, messages: trimmedMessages, updatedAt })
  );

  const list = await getConversationList(env, sessionId);
  const existing = list.find((c) => c.id === conversationId);
  const title = makeTitle(trimmedMessages);
  if (existing) {
    existing.title = title;
    existing.updatedAt = updatedAt;
  } else {
    list.push({ id: conversationId, title, updatedAt });
  }
  await saveConversationList(env, sessionId, list);
}

async function deleteConversation(env, sessionId, conversationId) {
  await env.CHAT_KV.delete(convKey(sessionId, conversationId));
  const list = await getConversationList(env, sessionId);
  await saveConversationList(env, sessionId, list.filter((c) => c.id !== conversationId));
}

// ---------------------------------------------------------------------------
// Provider adapters (unchanged from before)
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

  let full = "";
  await pipeSse(res, writer, (event) => {
    if (event.type === "content_block_delta" && event.delta?.text) {
      full += event.delta.text;
      return event.delta.text;
    }
    return null;
  });
  return { text: full };
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

  let full = "";
  await pipeSse(res, writer, (event) => {
    const t = event.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
    if (t) full += t;
    return t || null;
  });
  return { text: full };
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

  let full = "";
  await pipeSse(res, writer, (event) => {
    const t = event.choices?.[0]?.delta?.content || null;
    if (t) full += t;
    return t;
  });
  return { text: full };
}

// ---------------------------------------------------------------------------
// Shared SSE pump
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
    buffer = lines.pop();

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
// Fallback chain
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
    }
  }
  throw new Error(`All providers failed or unconfigured -> ${errors.join(" | ")}`);
}

const SYSTEM_PROMPT = `You are a helpful assistant embedded on a business website.
Be concise, friendly, and accurate. If you don't know something current, say so
rather than guessing. Keep replies under 120 words unless the user asks for more detail.`;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(env, origin);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers });

    if (!env.CHAT_KV) {
      return json({ error: "CHAT_KV binding missing — add it in Worker Settings > Bindings" }, 500, headers);
    }

    // ---------------- GET /api/conversations?sessionId=... ----------------
    if (request.method === "GET" && url.pathname === "/api/conversations") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) return json({ error: "sessionId required" }, 400, headers);
      const list = await getConversationList(env, sessionId);
      return json({ conversations: list }, 200, headers);
    }

    // ------------- GET /api/conversations/:id?sessionId=... -------------
    if (request.method === "GET" && url.pathname.startsWith("/api/conversations/")) {
      const sessionId = url.searchParams.get("sessionId");
      const id = url.pathname.split("/").pop();
      if (!sessionId || !id) return json({ error: "sessionId and id required" }, 400, headers);
      const conv = await getConversation(env, sessionId, id);
      if (!conv) return json({ error: "not found" }, 404, headers);
      return json(conv, 200, headers);
    }

    // ------------ DELETE /api/conversations/:id?sessionId=... ------------
    if (request.method === "DELETE" && url.pathname.startsWith("/api/conversations/")) {
      const sessionId = url.searchParams.get("sessionId");
      const id = url.pathname.split("/").pop();
      if (!sessionId || !id) return json({ error: "sessionId and id required" }, 400, headers);
      await deleteConversation(env, sessionId, id);
      return json({ ok: true }, 200, headers);
    }

    // ---------------------------- POST / (chat) ----------------------------
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400, headers);
    }

    const { messages = [], provider, stream = false, system, sessionId, conversationId } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "messages[] required" }, 400, headers);
    }

    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
    const chosen = provider && PROVIDERS[provider] ? provider : autoRoute(lastUser);
    const order = [chosen, ...DEFAULT_ORDER.filter((p) => p !== chosen)];

    // ---------------- non-streaming ----------------
    if (!stream) {
      try {
        const result = await runWithFallback(env, messages, { stream: false, system: system || SYSTEM_PROMPT }, order);

        if (sessionId && conversationId) {
          const fullMessages = [...messages, { role: "assistant", content: result.text }];
          await saveConversation(env, sessionId, conversationId, fullMessages);
        }

        return json(result, 200, headers);
      } catch (err) {
        return json({ error: err.message }, 502, headers);
      }
    }

    // ---------------- streaming (SSE) ----------------
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    (async () => {
      let finalText = "";
      try {
        const providerUsed = order.find((name) => PROVIDERS[name]?.isConfigured(env));
        await writer.write(new TextEncoder().encode(`data: ${JSON.stringify({ providerUsed })}\n\n`));
        const result = await runWithFallback(env, messages, { stream: true, writer, system: system || SYSTEM_PROMPT }, order);
        finalText = result?.text || "";
      } catch (err) {
        await writer.write(new TextEncoder().encode(`data: ${JSON.stringify({ error: err.message })}\n\n`));
      } finally {
        if (sessionId && conversationId && finalText) {
          const fullMessages = [...messages, { role: "assistant", content: finalText }];
          await saveConversation(env, sessionId, conversationId, fullMessages);
        }
        await writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  },
};
