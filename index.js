/**
 * ==========================================================================
 * RAWx BOT Backend — Claude + Gemini + Grok + memory + upload + search + generate + video
 * STEP 5 FIXED VERSION — ইমেজ জেনারেশন বাগ ফিক্স করা হয়েছে
 * ==========================================================================
 *
 * কী ফিক্স করা হয়েছে:
 * - generateImage() ফাংশনে Gemini API response format parsing improve করা
 * - বেটার error messages যাতে debug করা সহজ হয়
 * - Fallback logic যদি image response format ভিন্ন হয়
 *
 * ভিডিও জেনারেশন (Grok Imagine):
 *   - POST /api/generate/video/start — body { prompt, duration, resolution, aspectRatio }
 *   - GET /api/generate/video/status?id=REQUEST_ID — polling endpoint
 *   - Requires XAI_API_KEY + Grok Imagine video access on that account
 *   - বিলড: ~$0.05/second (mid-2026 rate)
 *
 * ডিপ্লয় করা:
 *   Cloudflare Dashboard → `the-o` Worker → Edit Code
 *   এই সম্পূর্ণ ফাইল কপি → Paste করুন → Deploy বাটন চাপুন
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

// Image-generation model — Gemini-এর image generation API
// এই model ID পরিবর্তন হতে পারে Google-এর update-এ
// যদি 404 হয়, Google AI Studio থেকে current image model খুঁজুন
const IMAGE_MODEL_ID = "gemini-3.1-flash-image-preview";

// Grok Imagine video model
const VIDEO_MODEL_ID = "grok-imagine-video";

const MAX_CONVERSATIONS_PER_SESSION = 50;
const MAX_MESSAGES_PER_CONVERSATION = 200;

// Image upload constraints
const MAX_IMAGES_PER_TURN = 3;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// Google Drive folder search configuration
const GDRIVE_FOLDER_ID = "1BNzQpgYtf-CB7GemrQVtqIWGQEkTiZIT";
const DRIVE_CACHE_KEY = "drive:filelist";
const DRIVE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 মিনিট
const DRIVE_MAX_RESULTS = 12;

// ---------------------------------------------------------------------------
// Google Drive Helper Functions
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Image + Document + Video Generation
// ---------------------------------------------------------------------------
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

// FIXED: Better error handling for Gemini image API response
async function generateImage(env, prompt) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL_ID}:generateContent?key=${env.GEMINI_API_KEY}`;

  console.log("[generateImage] Calling Gemini with model:", IMAGE_MODEL_ID);
  
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error("[generateImage] API error:", res.status, errorText);
    throw new Error(`Gemini image API ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  console.log("[generateImage] Response:", JSON.stringify(data).slice(0, 200) + "...");

  // Try to find image data in response — handle different possible formats
  let imagePart = null;
  
  // Format 1: inlineData (expected format)
  imagePart = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  
  // Format 2: If not found, check for other image representation formats
  if (!imagePart) {
    const allParts = data.candidates?.[0]?.content?.parts || [];
    console.log("[generateImage] Parts found:", allParts.length, "formats:", allParts.map(p => Object.keys(p)));
    
    // Try alternative formats (if Gemini API changed response structure)
    imagePart = allParts.find(
      (p) =>
        p.inlineData ||
        p.image ||
        p.imageData ||
        (p.data && (p.data.mimeType || "").includes("image"))
    );
  }

  if (!imagePart) {
    console.error("[generateImage] No image data in response. Full data:", JSON.stringify(data));
    throw new Error(
      "Model did not return an image — try a more descriptive prompt or check Gemini API status."
    );
  }

  // Extract media type and base64 data from whichever format we got
  let mediaType = "image/png"; // default
  let b64data = null;

  if (imagePart.inlineData) {
    mediaType = imagePart.inlineData.mimeType || "image/png";
    b64data = imagePart.inlineData.data;
  } else if (imagePart.image) {
    mediaType = imagePart.image.mimeType || "image/png";
    b64data = imagePart.image.data;
  } else if (imagePart.imageData) {
    mediaType = imagePart.imageData.mimeType || "image/png";
    b64data = imagePart.imageData.data;
  } else if (imagePart.data && imagePart.data.mimeType) {
    mediaType = imagePart.data.mimeType;
    b64data = imagePart.data.data;
  }

  if (!b64data) {
    throw new Error("Image part found but no base64 data extracted — API format may have changed.");
  }

  console.log("[generateImage] Success, media type:", mediaType);
  return { mediaType, data: b64data };
}

// Video generation — asynchronous, using Grok Imagine API
async function startVideoGeneration(env, { prompt, duration, resolution, aspectRatio }) {
  if (!env.XAI_API_KEY) throw new Error("XAI_API_KEY not configured");
  
  console.log("[startVideoGeneration] Submitting job:", { prompt: prompt.slice(0, 50), duration, resolution, aspectRatio });
  
  const res = await fetch("https://api.x.ai/v1/videos/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: VIDEO_MODEL_ID,
      prompt,
      duration: duration || 6,
      resolution: resolution || "480p",
      aspect_ratio: aspectRatio || "16:9",
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error("[startVideoGeneration] API error:", res.status, errorText);
    throw new Error(`xAI video API ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  if (!data.request_id) {
    console.error("[startVideoGeneration] No request_id:", data);
    throw new Error("xAI did not return a request_id — check that Grok Imagine video access is enabled");
  }

  console.log("[startVideoGeneration] Job submitted, request_id:", data.request_id);
  return { requestId: data.request_id };
}

async function checkVideoStatus(env, requestId) {
  if (!env.XAI_API_KEY) throw new Error("XAI_API_KEY not configured");
  
  const res = await fetch(`https://api.x.ai/v1/videos/${requestId}`, {
    headers: { Authorization: `Bearer ${env.XAI_API_KEY}` },
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error("[checkVideoStatus] API error:", res.status, errorText);
    throw new Error(`xAI video API ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  console.log("[checkVideoStatus] Status for", requestId, ":", data.status);
  return data;
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
// KV helpers
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
        // ignore malformed lines
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
    const approxBytes = Math.ceil((img.data.length * 3) / 4);
    if (approxBytes > MAX_IMAGE_BYTES) {
      return { ok: false, error: "image exceeds 4MB limit" };
    }
  }
  return { ok: true, images };
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(env, origin);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers });

    if (!env.CHAT_KV) {
      return json({ error: "CHAT_KV binding missing" }, 500, headers);
    }

    // GET /api/conversations?sessionId=...
    if (request.method === "GET" && url.pathname === "/api/conversations") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) return json({ error: "sessionId required" }, 400, headers);
      const list = await getConversationList(env, sessionId);
      return json({ conversations: list }, 200, headers);
    }

    // GET /api/conversations/:id?sessionId=...
    if (request.method === "GET" && url.pathname.startsWith("/api/conversations/")) {
      const sessionId = url.searchParams.get("sessionId");
      const id = url.pathname.split("/").pop();
      if (!sessionId || !id) return json({ error: "sessionId and id required" }, 400, headers);
      const conv = await getConversation(env, sessionId, id);
      if (!conv) return json({ error: "not found" }, 404, headers);
      return json(conv, 200, headers);
    }

    // DELETE /api/conversations/:id?sessionId=...
    if (request.method === "DELETE" && url.pathname.startsWith("/api/conversations/")) {
      const sessionId = url.searchParams.get("sessionId");
      const id = url.pathname.split("/").pop();
      if (!sessionId || !id) return json({ error: "sessionId and id required" }, 400, headers);
      await deleteConversation(env, sessionId, id);
      return json({ ok: true }, 200, headers);
    }

    // GET /api/drive-search?q=...
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

    // POST /api/generate/document
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

    // POST /api/generate/image
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
        console.error("[/api/generate/image]", err);
        return json({ error: err.message }, 502, headers);
      }
    }

    // POST /api/generate/video/start
    if (request.method === "POST" && url.pathname === "/api/generate/video/start") {
      let genBody;
      try {
        genBody = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400, headers);
      }
      const { prompt, duration, resolution, aspectRatio } = genBody;
      if (!prompt || !prompt.trim()) return json({ error: "prompt required" }, 400, headers);
      try {
        const result = await startVideoGeneration(env, {
          prompt: prompt.trim(),
          duration,
          resolution,
          aspectRatio,
        });
        return json(result, 200, headers);
      } catch (err) {
        console.error("[/api/generate/video/start]", err);
        return json({ error: err.message }, 502, headers);
      }
    }

    // GET /api/generate/video/status?id=...
    if (request.method === "GET" && url.pathname === "/api/generate/video/status") {
      const requestId = url.searchParams.get("id");
      if (!requestId) return json({ error: "id required" }, 400, headers);
      try {
        const result = await checkVideoStatus(env, requestId);
        return json(result, 200, headers);
      } catch (err) {
        console.error("[/api/generate/video/status]", err);
        return json({ error: err.message }, 502, headers);
      }
    }

    // POST / (chat)
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

    // Grok has no verified vision support
    if (hasImages && chosen === "grok") chosen = "gemini";

    let order = [chosen, ...DEFAULT_ORDER.filter((p) => p !== chosen)];
    if (hasImages) order = order.filter((p) => p !== "grok");

    const callOpts = { system: system || SYSTEM_PROMPT, images };

    // Non-streaming
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

    // Streaming (SSE)
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
