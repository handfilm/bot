/**
 * ==========================================================================
 * RAWx BOT Backend — Claude + Gemini + Grok + memory + upload + search + generate
 * ==========================================================================
 *
 * STEP 4 OF 4 (Memory > Upload > Search > Generate) — this file adds, on top
 * of the Step 3 (Memory + Upload + Search) backend, a small v1 of Generate:
 *
 *   - POST /api/generate/document — body { docType, brief }. docType is one
 *     of "quotation" | "specsheet" | "productcopy" (anything else falls back
 *     to productcopy). Calls the same Claude/Gemini/Grok fallback chain used
 *     for chat, with a document-specific system prompt, and returns
 *     { docType, text } as plain text (no markdown) meant to be copy-pasted.
 *   - POST /api/generate/image — body { prompt }. Calls Gemini's image model
 *     directly (reuses the existing GEMINI_API_KEY secret, no new secret
 *     needed) and returns { image: { mediaType, data } } where data is
 *     base64 PNG bytes.
 *   - Neither endpoint is saved to conversation history/KV — they're a
 *     separate one-shot tool, not part of the chat thread. Nothing new to
 *     configure on the Worker besides pasting this file and Deploy.
 *
 * Everything below this point (Memory + Upload + Search) is unchanged from
 * Step 3:
 *
 *   - GET /api/drive-search?q=... — searches a public "anyone with the link"
 *     Google Drive folder by filename keyword match (v1, no AI captioning
 *     yet). Requires a GDRIVE_API_KEY secret (Settings -> Variables and
 *     Secrets), no OAuth needed since the folder is publicly link-shared.
 *   - The file list is cached in CHAT_KV for 10 minutes so repeated searches
 *     don't re-hit the Drive API every time.
 *   - This indexes the WHOLE configured folder (GDRIVE_FOLDER_ID below) —
 *     no public/private separation yet. Anything in that folder is
 *     returned to anyone who searches a matching keyword on the public
 *     site. Revisit before adding anything sensitive to that folder.
 *
 * Everything below this point (Memory + Upload) is unchanged from Step 2:
 *
 *   - Images can be attached to a chat turn: POST body gets an optional
 *     `images: [{ mediaType, data }]` field (data = base64, no data: prefix).
 *   - Claude and Gemini both receive images as real vision input.
 *   - Grok has no verified vision support yet, so any turn that includes
 *     images is silently rerouted away from Grok (whether Grok was picked
 *     by the auto-router or explicitly selected in the provider dropdown) —
 *     it falls through to Gemini/Claude instead. No error is shown to the
 *     user for this.
 *   - Server-side validation mirrors the client limits (max 3 images per
 *     turn, 4MB each, jpeg/png/webp/gif only) as a second layer of defense.
 *   - Images are NEVER written to KV. When a turn with images is saved to
 *     conversation history, the image bytes are dropped and replaced with
 *     a short "[N image(s) attached]" marker on the saved user message.
 *     Reloading an old conversation will not show the image itself.
 *
 * DEPLOY:
 *   Paste this whole file into the Worker's Edit Code screen and hit
 *   Deploy (Save alone does not apply it). No other Worker settings need
 *   to change from Step 1 — same CHAT_KV binding, same secrets.
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

// Image-generation model (Step 4 / Generate). Google renames these fairly
// often — if this id ever 404s, open Google AI Studio -> your API key's
// project -> Models, find the current "image" capable Gemini model, and
// swap the string below. Uses the same GEMINI_API_KEY secret, no new
// secret needed.
const IMAGE_MODEL_ID = "gemini-3.1-flash-image-preview";

// Cap how many conversations we keep per session, and how many messages per
// conversation, so KV storage never grows unbounded on the free tier.
const MAX_CONVERSATIONS_PER_SESSION = 50;
const MAX_MESSAGES_PER_CONVERSATION = 200;

// ---------------------------------------------------------------------------
// Image upload limits (must match the client-side limits in chat-widget.js)
// ---------------------------------------------------------------------------
const MAX_IMAGES_PER_TURN = 3;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// ---------------------------------------------------------------------------
// Google Drive folder search (Step 3, v1 — filename keyword matching)
// ---------------------------------------------------------------------------
// Public "anyone with the link" Drive folder. Read-only access via a plain
// API key (Settings -> Variables and Secrets -> GDRIVE_API_KEY), no OAuth.
const GDRIVE_FOLDER_ID = "1BNzQpgYtf-CB7GemrQVtqIWGQEkTiZIT";
const DRIVE_CACHE_KEY = "drive:filelist";
const DRIVE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DRIVE_MAX_RESULTS = 12;

async function fetchDriveFileList(env) {
  if (!env.GDRIVE_API_KEY) {
    throw new Error("GDRIVE_API_KEY not configured");
  }
  const fields = "files(id,name,mimeType,webViewLink,thumbnailLink,iconLink)";
  const q = encodeURIComponent(`'${GDRIVE_FOLDER_ID}' in parents and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${encodeURIComponent(fields)}&pageSize=1000&key=${env.GDRIVE_API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.files || [];
}

async function getCachedDriveFiles(env) {
  const raw = await env.CHAT_KV.get(DRIVE_CACHE_KEY);
  if (raw) {
    const cached = JSON.parse(raw);
    if (Date.now() - cached.fetchedAt < DRIVE_CACHE_TTL_MS) {
      return cached.files;
    }
  }
  const files = await fetchDriveFileList(env);
  await env.CHAT_KV.put(DRIVE_CACHE_KEY, JSON.stringify({ files, fetchedAt: Date.now() }));
  return files;
}

function scoreDriveFiles(files, query) {
  const words = (query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (words.length === 0) return [];

  const scored = files
    .map((f) => {
      const name = (f.name || "").toLowerCase();
      let score = 0;
      for (const w of words) {
        if (name.includes(w)) score += 1;
      }
      return { file: f, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, DRIVE_MAX_RESULTS)
    .map((s) => ({
      id: s.file.id,
      name: s.file.name,
      mimeType: s.file.mimeType,
      webViewLink: s.file.webViewLink,
      thumbnailLink: s.file.thumbnailLink || null,
      iconLink: s.file.iconLink || null,
    }));

  return scored;
}

function validateImages(images) {
  if (images === undefined || images === null) return { ok: true, images: [] };
  if (!Array.isArray(images)) return { ok: false, error: "images must be an array" };
  if (images.length > MAX_IMAGES_PER_TURN) {
    return { ok: false, error: `Max ${MAX_IMAGES_PER_TURN} images per message` };
  }
  for (const img of images) {
    if (!img || typeof img.data !== "string" || typeof img.mediaType !== "string") {
      return { ok: false, error: "each image needs mediaType and data (base64)" };
    }
    if (!ALLOWED_IMAGE_TYPES.has(img.mediaType)) {
      return { ok: false, error: `unsupported image type: ${img.mediaType}` };
    }
    // base64 -> approx decoded byte size, without actually decoding
    const approxBytes = Math.ceil((img.data.length * 3) / 4);
    if (approxBytes > MAX_IMAGE_BYTES) {
      return { ok: false, error: "image exceeds 4MB limit" };
    }
  }
  return { ok: true, images };
}

// ---------------------------------------------------------------------------
// Document + image generation (Step 4, v1 — small on purpose)
// ---------------------------------------------------------------------------
// Each entry is the system prompt used for that document type. Keep the
// output plain text (no markdown tables/asterisks) since it's meant to be
// copy-pasted straight into an email, WhatsApp message, or another doc.
const DOC_TYPE_PROMPTS = {
  quotation: `You write export quotations for HANDS & HEAD Group / RAWx, a garment/leather-goods/jute/textile export business with 25 years of experience exporting to Japan.
Given a short brief from the owner (product, quantity, materials, any price/lead-time hints), write a clean, professional export quotation as plain text — buyer-ready. Include: product name/description, quantity, unit price (if given, else say "price on request"), materials, MOQ if mentioned, lead time if mentioned, payment terms if mentioned (else a standard placeholder like "L/C at sight" clearly marked as a placeholder to confirm), and a short professional closing line. No markdown formatting, no asterisks — plain text with line breaks, ready to paste into an email.`,
  specsheet: `You write product spec sheets for HANDS & HEAD Group / RAWx, a garment/leather-goods/jute/textile export business.
Given a short brief about a product, write a clean spec sheet as plain text with clearly labeled fields: Product Name, Category, Materials/Composition, Available Sizes, Available Colors, Construction/Finishing details, Packing details, and Notes. If the brief doesn't mention a field, write a sensible placeholder in [brackets] for the owner to fill in rather than inventing a false fact. No markdown formatting — plain text, ready to paste.`,
  productcopy: `You write buyer-facing product copy/catalog descriptions for HANDS & HEAD Group / RAWx, a garment/leather-goods/jute/textile export business with 25 years of experience exporting to Japan.
Given a short brief about a product, write 2-3 short paragraphs of persuasive, professional catalog copy suitable for a buyer-facing website or lookbook. Mention craftsmanship and export experience where natural. Plain text, no markdown formatting, no asterisks.`,
};

async function generateDocument(env, docType, brief) {
  const systemPrompt = DOC_TYPE_PROMPTS[docType] || DOC_TYPE_PROMPTS.productcopy;
  const order = DEFAULT_ORDER.filter((p) => PROVIDERS[p].isConfigured(env));
  if (order.length === 0) throw new Error("No AI provider configured");
  const result = await runWithFallback(
    env,
    [{ role: "user", content: brief }],
    { system: systemPrompt, images: [], stream: false },
    order
  );
  return result.text;
}

async function generateImage(env, prompt) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL_ID}:generateContent?key=${env.GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });

  if (!res.ok) throw new Error(`Gemini image API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error("Model did not return an image — try a more descriptive prompt.");
  return { mediaType: part.inlineData.mimeType || "image/png", data: part.inlineData.data };
}

// ---------------------------------------------------------------------------
// Auto-router
// ---------------------------------------------------------------------------
function autoRoute(lastUserMessage, hasImages) {
  if (hasImages) return "gemini";
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

// Build the exact text that gets persisted to KV for a user turn that had
// images attached. We never store the image bytes themselves.
function imageMarker(count) {
  return `[${count} image${count > 1 ? "s" : ""} attached]`;
}

function messagesForStorage(messages, imageCount) {
  if (!imageCount || messages.length === 0) return messages;
  const out = [...messages];
  const lastIdx = out.length - 1;
  const last = out[lastIdx];
  out[lastIdx] = {
    ...last,
    content: last.content ? `${last.content}\n\n${imageMarker(imageCount)}` : imageMarker(imageCount),
  };
  return out;
}

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

// Attach images (if any) to the last message only, in each provider's own
// vision format. `images` is [] when there are none, so this is a no-op for
// plain text turns and for every message except the newest one.
function withImagesForClaude(messages, images) {
  if (!images || images.length === 0) {
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }
  const lastIdx = messages.length - 1;
  return messages.map((m, idx) => {
    if (idx !== lastIdx || m.role !== "user") return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: [
        ...images.map((img) => ({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.data },
        })),
        { type: "text", text: m.content || "" },
      ],
    };
  });
}

function withImagesForGemini(messages, images) {
  const lastIdx = messages.length - 1;
  return messages.map((m, idx) => {
    const role = m.role === "assistant" ? "model" : "user";
    if (idx === lastIdx && m.role === "user" && images && images.length > 0) {
      return {
        role,
        parts: [
          ...images.map((img) => ({ inlineData: { mimeType: img.mediaType, data: img.data } })),
          { text: m.content || "" },
        ],
      };
    }
    return { role, parts: [{ text: m.content }] };
  });
}

async function callClaude(env, messages, { stream, writer, system, images }) {
  const anthropicMessages = withImagesForClaude(messages, images);

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

async function callGemini(env, messages, { stream, writer, system, images }) {
  const contents = withImagesForGemini(messages, images);

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

// Grok: text-only. This function is never called for a turn that has
// images — the router removes "grok" from the provider order whenever
// images are present (see runRouter below) — but it's written defensively
// in case that ever changes.
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

    // ---------------------- GET /api/drive-search?q=... ----------------------
    if (request.method === "GET" && url.pathname === "/api/drive-search") {
      const q = url.searchParams.get("q") || "";
      if (!q.trim()) return json({ query: q, results: [] }, 200, headers);
      try {
        const files = await getCachedDriveFiles(env);
        const results = scoreDriveFiles(files, q);
        return json({ query: q, results }, 200, headers);
      } catch (err) {
        return json({ error: err.message }, 502, headers);
      }
    }

    // ---------------- POST /api/generate/document ----------------
    if (request.method === "POST" && url.pathname === "/api/generate/document") {
      let genBody;
      try {
        genBody = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400, headers);
      }
      const { docType, brief } = genBody;
      if (!brief || !brief.trim()) return json({ error: "brief required" }, 400, headers);
      try {
        const text = await generateDocument(env, docType, brief.trim());
        return json({ docType: docType || "productcopy", text }, 200, headers);
      } catch (err) {
        return json({ error: err.message }, 502, headers);
      }
    }

    // ---------------- POST /api/generate/image ----------------
    if (request.method === "POST" && url.pathname === "/api/generate/image") {
      let genBody;
      try {
        genBody = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400, headers);
      }
      const { prompt } = genBody;
      if (!prompt || !prompt.trim()) return json({ error: "prompt required" }, 400, headers);
      try {
        const image = await generateImage(env, prompt.trim());
        return json({ image }, 200, headers);
      } catch (err) {
        return json({ error: err.message }, 502, headers);
      }
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

    const imageCheck = validateImages(body.images);
    if (!imageCheck.ok) {
      return json({ error: imageCheck.error }, 400, headers);
    }
    const images = imageCheck.images;
    const hasImages = images.length > 0;

    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
    let chosen = provider && PROVIDERS[provider] ? provider : autoRoute(lastUser, hasImages);

    // Grok has no verified vision support — reroute silently, whether Grok
    // was auto-picked or explicitly chosen in the dropdown.
    if (hasImages && chosen === "grok") chosen = "gemini";

    let order = [chosen, ...DEFAULT_ORDER.filter((p) => p !== chosen)];
    if (hasImages) order = order.filter((p) => p !== "grok");

    const callOpts = { system: system || SYSTEM_PROMPT, images };

    // ---------------- non-streaming ----------------
    if (!stream) {
      try {
        const result = await runWithFallback(env, messages, { ...callOpts, stream: false }, order);

        if (sessionId && conversationId) {
          const storedMessages = messagesForStorage(messages, images.length);
          const fullMessages = [...storedMessages, { role: "assistant", content: result.text }];
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
        const result = await runWithFallback(env, messages, { ...callOpts, stream: true, writer }, order);
        finalText = result?.text || "";
      } catch (err) {
        await writer.write(new TextEncoder().encode(`data: ${JSON.stringify({ error: err.message })}\n\n`));
      } finally {
        if (sessionId && conversationId && finalText) {
          const storedMessages = messagesForStorage(messages, images.length);
          const fullMessages = [...storedMessages, { role: "assistant", content: finalText }];
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
