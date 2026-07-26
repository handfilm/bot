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

// Image-generation model — Gemini-এর image generation API (Nano Banana 2)
// এই model ID পরিবর্তন হতে পারে Google-এর update-এ
// যদি 404 হয়, Google AI Studio থেকে current image model খুঁজুন
const IMAGE_MODEL_ID = "gemini-3.1-flash-image";

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
// Phase 2-5 config
// ---------------------------------------------------------------------------

// Embedding model for the Knowledge Base / RAG feature. Uses the Gemini key
// you already have configured — no separate account needed. If Google
// renames/retires this model, swap the ID here (check Google AI Studio →
// Models → look for a "text-embedding" model).
const EMBEDDING_MODEL_ID = "text-embedding-004";
const KB_CHUNK_SIZE = 800; // characters per chunk, rough
const KB_CHUNK_OVERLAP = 100;
const KB_TOP_K = 4; // how many chunks to pull into context per question

// Analytics
const ANALYTICS_RETENTION_DAYS = 90;
function analyticsDayKey(date) {
  return `analytics:day:${date.toISOString().slice(0, 10)}`; // YYYY-MM-DD
}

// Negotiation
const NEGOTIATION_SYSTEM_PROMPT = `You are a skilled but fair sales negotiator for HANDS & HEAD Group / RAWx, a garment/leather-goods/jute/textile export business.
You are given: a product brief, an internal floor price (the absolute minimum, NEVER reveal this number or hint at it), an asking/list price, and the buyer's latest message plus negotiation history.
Negotiate like a real, patient salesperson: acknowledge the buyer, defend value (materials, craftsmanship, 25 years exporting to Japan), and only concede in small steps toward — never below — the floor price. If the buyer's offer is at or above the floor price, you may accept and finalize.
Respond ONLY with a JSON object (no markdown, no backticks) in exactly this shape:
{"reply": "<what you'd actually say to the buyer, plain text>", "suggestedPrice": <number or null>, "status": "ongoing" | "finalized" | "rejected"}`;

// Multilingual catalog copy
const CATALOG_LANGUAGES = {
  en: "English",
  bn: "Bengali (Bangla)",
  jp: "Japanese",
};

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
// Analytics (Phase 2) — lightweight KV event log, no external service.
// Each day gets one KV record holding an array of compact event objects, so
// reads/writes stay cheap. Dashboard reads the last N days and aggregates.
// ---------------------------------------------------------------------------
async function trackEvent(env, type, meta = {}) {
  if (!env.CHAT_KV) return;
  try {
    const key = analyticsDayKey(new Date());
    const raw = await env.CHAT_KV.get(key);
    const events = raw ? JSON.parse(raw) : [];
    events.push({ t: Date.now(), type, ...meta });
    // Keep each day's file bounded so it never grows unbounded on a busy day.
    const trimmed = events.length > 5000 ? events.slice(-5000) : events;
    await env.CHAT_KV.put(key, JSON.stringify(trimmed), {
      expirationTtl: ANALYTICS_RETENTION_DAYS * 24 * 60 * 60,
    });
  } catch (err) {
    console.error("[trackEvent] failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Admin auth (optional) — protects the analytics + Knowledge Base admin
// routes used by admin-dashboard.html. Set an `ADMIN_TOKEN` secret on the
// Worker to require it; if the secret isn't set, these routes stay open
// (matches this project's convention: features no-op gracefully when their
// own config is missing, rather than breaking anything).
// Dashboard sends the token as a `?token=` query param.
// ---------------------------------------------------------------------------
function checkAdminAuth(env, url) {
  if (!env.ADMIN_TOKEN) return true;
  return url.searchParams.get("token") === env.ADMIN_TOKEN;
}

async function getAnalyticsSummary(env, days) {
  const numDays = Math.min(Math.max(Number(days) || 7, 1), ANALYTICS_RETENTION_DAYS);
  const now = new Date();
  const perDay = [];
  const providerCounts = {};
  const questionCounts = {};
  const reactionCounts = {};
  let totalMessages = 0;
  let totalResponseTimeMs = 0;
  let responseTimeSamples = 0;

  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = analyticsDayKey(d);
    const raw = await env.CHAT_KV.get(key);
    const events = raw ? JSON.parse(raw) : [];

    let dayMessages = 0;
    for (const e of events) {
      if (e.type === "message") {
        dayMessages += 1;
        totalMessages += 1;
        if (e.provider) providerCounts[e.provider] = (providerCounts[e.provider] || 0) + 1;
        if (typeof e.responseMs === "number") {
          totalResponseTimeMs += e.responseMs;
          responseTimeSamples += 1;
        }
        if (e.question) {
          const q = e.question.toLowerCase().trim().slice(0, 80);
          if (q) questionCounts[q] = (questionCounts[q] || 0) + 1;
        }
      }
      if (e.type === "reaction" && e.emoji) {
        reactionCounts[e.emoji] = (reactionCounts[e.emoji] || 0) + 1;
      }
    }
    perDay.push({ date: d.toISOString().slice(0, 10), messages: dayMessages });
  }

  const topQuestions = Object.entries(questionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([question, count]) => ({ question, count }));

  return {
    rangeDays: numDays,
    totalMessages,
    avgResponseMs: responseTimeSamples ? Math.round(totalResponseTimeMs / responseTimeSamples) : null,
    providerCounts,
    reactionCounts,
    topQuestions,
    perDay,
  };
}

// ---------------------------------------------------------------------------
// Knowledge Base / RAG (Phase 2)
// Requires: a Cloudflare Vectorize index bound as `KB_VECTORIZE` in the
// Worker's settings, created once via wrangler CLI:
//   wrangler vectorize create rawx-kb --dimensions=768 --metric=cosine
//   wrangler.toml (or Dashboard → Settings → Bindings → Vectorize):
//     [[vectorize]]
//     binding = "KB_VECTORIZE"
//     index_name = "rawx-kb"
// Chunk metadata (title/text) is stored alongside each vector so retrieval
// doesn't need a second KV round-trip.
// ---------------------------------------------------------------------------
async function embedText(env, text) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured (needed for embeddings)");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL_ID}:embedContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL_ID}`,
      content: { parts: [{ text }] },
    }),
  });
  if (!res.ok) throw new Error(`Embedding API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const values = data.embedding?.values;
  if (!Array.isArray(values)) throw new Error("Embedding API returned no vector — check model ID");
  return values;
}

function chunkText(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + KB_CHUNK_SIZE, clean.length);
    chunks.push(clean.slice(start, end));
    if (end === clean.length) break;
    start = end - KB_CHUNK_OVERLAP;
  }
  return chunks;
}

async function kbUpload(env, title, text) {
  if (!env.KB_VECTORIZE) throw new Error("KB_VECTORIZE binding not configured — see comments in index.js");
  const chunks = chunkText(text);
  if (chunks.length === 0) throw new Error("nothing to index — text was empty");

  const docId = crypto.randomUUID();
  const vectors = [];
  for (let i = 0; i < chunks.length; i++) {
    const values = await embedText(env, chunks[i]);
    vectors.push({
      id: `${docId}-${i}`,
      values,
      metadata: { title: title || "Untitled", text: chunks[i], chunkIndex: i, docId },
    });
  }
  await env.KB_VECTORIZE.upsert(vectors);

  // Vectorize has no native "list all uploaded docs" query, so keep a small
  // parallel record in KV purely for the admin dashboard's doc list. The
  // vectors themselves remain the source of truth for retrieval.
  if (env.CHAT_KV) {
    await env.CHAT_KV.put(
      `kb:doc:${docId}`,
      JSON.stringify({ id: docId, title: title || "Untitled", chunkCount: vectors.length, uploadedAt: Date.now() })
    );
  }

  return { chunksIndexed: vectors.length, docId };
}

async function kbListDocs(env) {
  if (!env.KB_VECTORIZE) return { configured: false, docs: [] };
  if (!env.CHAT_KV) return { configured: true, docs: [] };
  const list = await env.CHAT_KV.list({ prefix: "kb:doc:" });
  const docs = [];
  for (const k of list.keys) {
    const raw = await env.CHAT_KV.get(k.name);
    if (raw) docs.push(JSON.parse(raw));
  }
  docs.sort((a, b) => b.uploadedAt - a.uploadedAt);
  return { configured: true, docs };
}

async function kbRetrieveContext(env, query) {
  if (!env.KB_VECTORIZE) return null; // KB feature simply not configured — chat proceeds without it
  try {
    const queryVector = await embedText(env, query);
    const results = await env.KB_VECTORIZE.query(queryVector, { topK: KB_TOP_K, returnMetadata: true });
    const matches = (results.matches || []).filter((m) => m.score > 0.72);
    if (matches.length === 0) return null;
    return matches
      .map((m) => `[${m.metadata?.title || "Reference"}] ${m.metadata?.text || ""}`)
      .join("\n---\n");
  } catch (err) {
    console.error("[kbRetrieveContext] failed:", err.message);
    return null; // never block chat because retrieval failed
  }
}

// ---------------------------------------------------------------------------
// WhatsApp Integration (Phase 2)
// Requires Twilio secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_WHATSAPP_NUMBER (e.g. "whatsapp:+14155238886" for the sandbox).
// Point Twilio's WhatsApp Sandbox / Business webhook at:
//   POST https://<your-worker>/api/whatsapp/webhook
// Twilio sends application/x-www-form-urlencoded, not JSON.
// ---------------------------------------------------------------------------
async function sendWhatsAppMessage(env, to, body) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_WHATSAPP_NUMBER;
  if (!sid || !token || !from) throw new Error("Twilio secrets not configured");

  const auth = btoa(`${sid}:${token}`);
  const form = new URLSearchParams({ From: from, To: to, Body: body });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  if (!res.ok) throw new Error(`Twilio API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Verifies that a webhook POST really came from Twilio, per Twilio's signing
// scheme: HMAC-SHA1 over (exact request URL + sorted "key"+"value" pairs of
// every form field), keyed with the Auth Token, base64-encoded, and compared
// to the X-Twilio-Signature header. The URL here must match EXACTLY what is
// configured as the webhook URL in the Twilio console (same scheme, host,
// path, and query string) or valid requests will fail verification too.
async function verifyTwilioSignature(url, formData, authToken, signatureHeader) {
  if (!signatureHeader) return false;
  let data = url;
  const keys = [...formData.keys()].sort();
  for (const key of keys) data += key + formData.get(key);

  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));
  return computed === signatureHeader;
}

async function handleWhatsAppWebhook(request, env) {
  const formData = await request.formData();

  if (env.TWILIO_AUTH_TOKEN) {
    const signatureHeader = request.headers.get("X-Twilio-Signature");
    const valid = await verifyTwilioSignature(request.url, formData, env.TWILIO_AUTH_TOKEN, signatureHeader);
    if (!valid) {
      console.error("[handleWhatsAppWebhook] rejected: invalid or missing X-Twilio-Signature");
      return new Response("Forbidden", { status: 403 });
    }
  }
  // If TWILIO_AUTH_TOKEN isn't set yet, signature checking is skipped so the
  // feature doesn't break — but sendWhatsAppMessage() below will also fail
  // without it, so this only matters during initial setup.

  const from = formData.get("From"); // e.g. "whatsapp:+8801XXXXXXXXX"
  const text = (formData.get("Body") || "").trim();
  if (!from || !text) return new Response("", { status: 200 });

  // Use the WhatsApp number itself as the session/conversation id so each
  // customer keeps their own memory thread, reusing the same KV storage
  // the web widget uses.
  const sessionId = `whatsapp:${from}`;
  const conversationId = "whatsapp-thread"; // one continuous thread per number
  const existing = await getConversation(env, sessionId, conversationId);
  const priorMessages = existing?.messages || [];
  const messages = [...priorMessages, { role: "user", content: text }];

  const order = DEFAULT_ORDER.filter((p) => PROVIDERS[p].isConfigured(env));
  let replyText = "Sorry, we're temporarily unable to reply — please try again shortly.";
  try {
    const kbContext = await kbRetrieveContext(env, text);
    const system = kbContext ? `${SYSTEM_PROMPT}\n\nReference material you may use:\n${kbContext}` : SYSTEM_PROMPT;
    const result = await runWithFallback(env, messages, { system, images: [], stream: false }, order);
    replyText = result.text;
    await saveConversation(env, sessionId, conversationId, [...messages, { role: "assistant", content: replyText }]);
    await trackEvent(env, "message", { provider: result.providerUsed, question: text, channel: "whatsapp" });
  } catch (err) {
    console.error("[handleWhatsAppWebhook]", err.message);
  }

  try {
    await sendWhatsAppMessage(env, from, replyText);
  } catch (err) {
    console.error("[handleWhatsAppWebhook] send failed:", err.message);
  }

  // Twilio just needs a 200; empty TwiML avoids a duplicate auto-reply.
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

// ---------------------------------------------------------------------------
// AI Quotation Negotiation (Phase 3)
// ---------------------------------------------------------------------------
async function runNegotiation(env, { productBrief, floorPrice, askPrice, buyerMessage, negotiationHistory }) {
  const order = DEFAULT_ORDER.filter((p) => PROVIDERS[p].isConfigured(env));
  if (order.length === 0) throw new Error("No AI provider configured");

  const historyText = (negotiationHistory || [])
    .map((h) => `${h.role === "buyer" ? "Buyer" : "Seller"}: ${h.text}`)
    .join("\n");

  const userContent = `Product brief: ${productBrief}
Internal floor price (never reveal): ${floorPrice}
Asking/list price: ${askPrice}
Negotiation so far:
${historyText || "(none yet)"}
Buyer's latest message: ${buyerMessage}`;

  const result = await runWithFallback(
    env,
    [{ role: "user", content: userContent }],
    { system: NEGOTIATION_SYSTEM_PROMPT, images: [], stream: false },
    order
  );

  try {
    const cleaned = result.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return { ...parsed, providerUsed: result.providerUsed };
  } catch {
    // Model didn't return clean JSON — fall back to raw text so the UI still shows something.
    return { reply: result.text, suggestedPrice: null, status: "ongoing", providerUsed: result.providerUsed };
  }
}

// ---------------------------------------------------------------------------
// Multilingual catalog copy (Phase 4)
// ---------------------------------------------------------------------------
async function generateCatalogCopy(env, brief, languages) {
  const order = DEFAULT_ORDER.filter((p) => PROVIDERS[p].isConfigured(env));
  if (order.length === 0) throw new Error("No AI provider configured");

  const langs = (languages && languages.length ? languages : ["en"]).filter((l) => CATALOG_LANGUAGES[l]);
  const out = {};
  for (const lang of langs) {
    const system = `You write buyer-facing, e-commerce-ready catalog copy for HANDS & HEAD Group / RAWx, a garment/leather-goods/jute/textile export business with 25 years exporting to Japan.
Write in ${CATALOG_LANGUAGES[lang]} ONLY. Given a short product brief, return a JSON object (no markdown, no backticks) shaped exactly like:
{"description": "<2-3 short paragraphs, persuasive, Amazon/Etsy-ready>", "hashtags": ["#tag1", "#tag2", "..."]}`;
    const result = await runWithFallback(
      env,
      [{ role: "user", content: brief }],
      { system, images: [], stream: false },
      order
    );
    try {
      const cleaned = result.text.replace(/```json|```/g, "").trim();
      out[lang] = JSON.parse(cleaned);
    } catch {
      out[lang] = { description: result.text, hashtags: [] };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Product demo video prompt builder (Phase 4) — builds on the Grok Imagine
// video pipeline above; turns a short product brief into a well-formed
// ~30s marketing video prompt instead of asking the owner to write one.
// ---------------------------------------------------------------------------
async function buildDemoVideoPrompt(env, productBrief) {
  const order = DEFAULT_ORDER.filter((p) => PROVIDERS[p].isConfigured(env));
  if (order.length === 0) return productBrief; // no AI configured — just use the raw brief
  const system = `You write short, vivid prompts (2-4 sentences, plain text, no markdown) for an AI video generator, describing a ~30 second product marketing clip. Given a brief about an export product (garment/leather/jute/textile), describe camera movement, lighting, and setting suitable for a professional B2B catalog/marketing video. No text overlays, no logos.`;
  try {
    const result = await runWithFallback(env, [{ role: "user", content: productBrief }], { system, images: [], stream: false }, order);
    return result.text || productBrief;
  } catch {
    return productBrief;
  }
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
// `ALLOWED_ORIGIN` can be "*", a single origin, or a comma-separated list
// (e.g. "https://bot.handsandhead.com,https://www.handsandhead.com") so the
// widget/dashboard works when embedded on more than one page/subdomain.
// ---------------------------------------------------------------------------
function corsHeaders(env, origin) {
  const configured = env.ALLOWED_ORIGIN || "*";
  let allowOrigin = "*";
  if (configured !== "*") {
    const allowedList = configured.split(",").map((o) => o.trim()).filter(Boolean);
    allowOrigin = allowedList.includes(origin) ? origin : allowedList[0] || "*";
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
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

// Emoji reactions (Phase 3) — tag a stored message with a reaction so it's
// visible next time the conversation loads, and log it for analytics.
async function reactToMessage(env, sessionId, conversationId, messageIndex, emoji) {
  const conv = await getConversation(env, sessionId, conversationId);
  if (!conv) throw new Error("conversation not found");
  if (!conv.messages[messageIndex]) throw new Error("message not found");
  conv.messages[messageIndex] = { ...conv.messages[messageIndex], reaction: emoji || null };
  await env.CHAT_KV.put(convKey(sessionId, conversationId), JSON.stringify(conv));
  if (emoji) await trackEvent(env, "reaction", { emoji });
  return conv;
}

// ---------------------------------------------------------------------------
// Real-time collaboration — LITE version (Phase 3)
// True sub-second multiplayer (two people typing in the same thread live)
// needs a Cloudflare Durable Object, which has to be declared as a class
// binding in wrangler.toml and deployed via `wrangler deploy` — it can't be
// pasted into the dashboard code editor like the rest of this Worker, so
// it's intentionally NOT included here. See the comment block at the very
// bottom of this file for a starter Durable Object you can add later.
//
// What IS included: a read-only "share" link. Anyone with the link polls
// the same KV-backed conversation every few seconds and sees new messages
// as they land — good enough for "let a colleague watch this quote get
// negotiated" without needing WebSockets.
// ---------------------------------------------------------------------------
async function createShareLink(env, sessionId, conversationId) {
  const conv = await getConversation(env, sessionId, conversationId);
  if (!conv) throw new Error("conversation not found");
  const shareId = crypto.randomUUID();
  await env.CHAT_KV.put(
    `share:${shareId}`,
    JSON.stringify({ sessionId, conversationId }),
    { expirationTtl: 7 * 24 * 60 * 60 } // share links expire after 7 days
  );
  return shareId;
}

async function getSharedConversation(env, shareId) {
  const raw = await env.CHAT_KV.get(`share:${shareId}`);
  if (!raw) throw new Error("share link not found or expired");
  const { sessionId, conversationId } = JSON.parse(raw);
  const conv = await getConversation(env, sessionId, conversationId);
  if (!conv) throw new Error("conversation not found");
  return conv;
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
// Admin dashboard page — served directly by the Worker so it can be opened
// as a normal https:// URL (e.g. on a phone) instead of needing a locally
// saved HTML file, which mobile browsers often block from making
// cross-origin fetch() calls to the Worker.
// ---------------------------------------------------------------------------
const ADMIN_DASHBOARD_HTML = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\" />\n<title>RAWx Bot — Admin</title>\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n<meta name=\"robots\" content=\"noindex, nofollow\" />\n<style>\n  body{ font-family: system-ui, sans-serif; background:#111; color:#eee; margin:0; padding:24px; }\n  h1{ font-size:1.1rem; margin:0 0 4px; }\n  .sub{ color:#888; font-size:0.8rem; margin-bottom:20px; }\n  .row{ display:flex; gap:12px; flex-wrap:wrap; margin-bottom:20px; }\n  .card{ background:#1a1a1a; border:1px solid #333; border-radius:10px; padding:14px 18px; min-width:140px; }\n  .card .num{ font-size:1.6rem; font-weight:700; }\n  .card .label{ font-size:0.75rem; color:#999; margin-top:2px; }\n  #setup, .box{ background:#1a1a1a; border:1px solid #333; border-radius:10px; padding:16px; margin-bottom:20px; }\n  input, textarea{ width:100%; box-sizing:border-box; padding:8px 10px; border-radius:6px; border:1px solid #444; background:#0d0d0d; color:#eee; font-size:0.85rem; margin-top:6px; font-family:inherit; }\n  label{ font-size:0.8rem; color:#ccc; }\n  button{ margin-top:10px; background:#fff; color:#111; border:none; border-radius:6px; padding:8px 16px; font-size:0.82rem; cursor:pointer; }\n  canvas{ background:#1a1a1a; border:1px solid #333; border-radius:10px; padding:12px; max-width:100%; }\n  .err{ color:#e66; font-size:0.85rem; margin-top:8px; }\n</style>\n</head>\n<body>\n  <h1>RAWx Bot — Admin</h1>\n  <div class=\"sub\">Aggregate usage + knowledge base only — no message content is ever shown here.</div>\n\n  <div id=\"setup\">\n    <label for=\"endpoint\">Worker URL</label>\n    <input id=\"endpoint\" placeholder=\"https://the-o.himon.workers.dev\" />\n    <label for=\"token\" style=\"margin-top:8px; display:block;\">Admin token (only needed if you set an ADMIN_TOKEN secret on the Worker)</label>\n    <input id=\"token\" placeholder=\"optional\" />\n    <button id=\"load\">Load dashboard</button>\n  </div>\n\n  <div id=\"error\" class=\"err\"></div>\n  <div class=\"row\" id=\"cards\"></div>\n  <canvas id=\"chart\" height=\"220\"></canvas>\n\n  <h1 style=\"margin-top:32px;\">Knowledge Base</h1>\n  <div class=\"sub\" id=\"kbStatus\">—</div>\n  <div class=\"box\">\n    <label for=\"kbTitle\">Document title</label>\n    <input id=\"kbTitle\" placeholder=\"e.g. 2026 Standard Pricing\" />\n    <label for=\"kbText\" style=\"margin-top:8px; display:block;\">Text content</label>\n    <textarea id=\"kbText\" rows=\"6\" placeholder=\"Paste quotation text, spec sheet, price list, etc.\"></textarea>\n    <button id=\"kbUpload\">Upload to Knowledge Base</button>\n    <div id=\"kbError\" class=\"err\"></div>\n  </div>\n  <div id=\"kbList\"></div>\n\n  <script>\n    const $ = (id) => document.getElementById(id);\n    const ENDPOINT_KEY = \"rawx_admin_endpoint\";\n    const TOKEN_KEY = \"rawx_admin_token\";\n\n    $(\"endpoint\").value = localStorage.getItem(ENDPOINT_KEY) || (location.protocol.startsWith(\"http\") ? location.origin : \"\");\n    $(\"token\").value = localStorage.getItem(TOKEN_KEY) || \"\";\n\n    function card(num, label) {\n      const el = document.createElement(\"div\");\n      el.className = \"card\";\n      el.innerHTML = `<div class=\"num\">${num}</div><div class=\"label\">${label}</div>`;\n      return el;\n    }\n\n    function drawBarChart(canvas, days) {\n      const ctx = canvas.getContext(\"2d\");\n      const w = (canvas.width = canvas.clientWidth || 600);\n      const h = canvas.height;\n      ctx.clearRect(0, 0, w, h);\n      if (days.length === 0) return;\n      const max = Math.max(...days.map((d) => d.count), 1);\n      const barW = w / days.length;\n      ctx.font = \"10px system-ui\";\n      days.forEach((d, i) => {\n        const barH = (d.count / max) * (h - 40);\n        const x = i * barW + 4;\n        const y = h - barH - 24;\n        ctx.fillStyle = \"#4caf50\";\n        ctx.fillRect(x, y, barW - 8, barH);\n        ctx.fillStyle = \"#999\";\n        ctx.fillText(d.day.slice(5), x, h - 10);\n        ctx.fillText(String(d.count), x, y - 4);\n      });\n    }\n\n    async function loadStats() {\n      const endpoint = $(\"endpoint\").value.trim().replace(/\\/$/, \"\");\n      const token = $(\"token\").value.trim();\n      $(\"error\").textContent = \"\";\n      $(\"cards\").innerHTML = \"\";\n      if (!endpoint) {\n        $(\"error\").textContent = \"Enter your Worker URL first.\";\n        return;\n      }\n      localStorage.setItem(ENDPOINT_KEY, endpoint);\n      localStorage.setItem(TOKEN_KEY, token);\n\n      try {\n        const url = new URL(endpoint + \"/api/analytics/summary\");\n        if (token) url.searchParams.set(\"token\", token);\n        const res = await fetch(url.toString());\n        if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.status === 401 ? \"wrong/missing token\" : \"request failed\"}`);\n        const stats = await res.json();\n\n        $(\"cards\").appendChild(card(stats.totalMessages || 0, \"Total replies (all time)\"));\n        if (stats.avgResponseMs) $(\"cards\").appendChild(card(`${stats.avgResponseMs}ms`, \"Avg response time\"));\n        Object.entries(stats.providerCounts || {}).forEach(([name, count]) => $(\"cards\").appendChild(card(count, `via ${name}`)));\n\n        const days = (stats.perDay || []).map((d) => ({ day: d.date, count: d.messages }));\n        drawBarChart($(\"chart\"), days);\n      } catch (err) {\n        $(\"error\").textContent = err.message;\n      }\n    }\n\n    async function loadKb() {\n      const endpoint = $(\"endpoint\").value.trim().replace(/\\/$/, \"\");\n      const token = $(\"token\").value.trim();\n      if (!endpoint) return;\n      try {\n        const url = new URL(endpoint + \"/api/kb/list\");\n        if (token) url.searchParams.set(\"token\", token);\n        const res = await fetch(url.toString());\n        const data = await res.json();\n        if (!res.ok) throw new Error(data.error || \"request failed\");\n        $(\"kbStatus\").textContent = data.configured\n          ? `${data.docs.length} document(s) uploaded`\n          : \"Not configured yet — add the KB_VECTORIZE and AI bindings on the Worker first (see index.js comments).\";\n        $(\"kbList\").innerHTML = (data.docs || [])\n          .map(\n            (d) =>\n              `<div class=\"card\" style=\"margin-bottom:8px;\"><div class=\"label\">${new Date(d.uploadedAt).toLocaleString()}</div><div>${d.title} — ${d.chunkCount} chunk(s)</div></div>`\n          )\n          .join(\"\");\n      } catch (err) {\n        $(\"kbStatus\").textContent = err.message;\n      }\n    }\n\n    $(\"kbUpload\").addEventListener(\"click\", async () => {\n      const endpoint = $(\"endpoint\").value.trim().replace(/\\/$/, \"\");\n      const token = $(\"token\").value.trim();\n      const title = $(\"kbTitle\").value.trim();\n      const text = $(\"kbText\").value.trim();\n      $(\"kbError\").textContent = \"\";\n      if (!endpoint || !title || !text) {\n        $(\"kbError\").textContent = \"Worker URL, title, and text are all required.\";\n        return;\n      }\n      try {\n        const url = new URL(endpoint + \"/api/kb/upload\");\n        if (token) url.searchParams.set(\"token\", token);\n        const res = await fetch(url.toString(), {\n          method: \"POST\",\n          headers: { \"Content-Type\": \"application/json\" },\n          body: JSON.stringify({ title, text }),\n        });\n        const data = await res.json();\n        if (!res.ok) throw new Error(data.error || \"upload failed\");\n        $(\"kbTitle\").value = \"\";\n        $(\"kbText\").value = \"\";\n        loadKb();\n      } catch (err) {\n        $(\"kbError\").textContent = err.message;\n      }\n    });\n\n    $(\"load\").addEventListener(\"click\", () => {\n      loadStats();\n      loadKb();\n    });\n    if ($(\"endpoint\").value) {\n      loadStats();\n      loadKb();\n    }\n  </script>\n</body>\n</html>\n";

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(env, origin);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers });

    // WhatsApp webhook — Twilio posts form-encoded data, not JSON, and
    // doesn't send an Origin header the way a browser does, so this is
    // handled before the CHAT_KV guard's JSON-only assumptions elsewhere.
    if (request.method === "POST" && url.pathname === "/api/whatsapp/webhook") {
      if (!env.CHAT_KV) return new Response("", { status: 200 });
      try {
        return await handleWhatsAppWebhook(request, env);
      } catch (err) {
        console.error("[/api/whatsapp/webhook]", err.message);
        return new Response("", { status: 200 }); // always 200 so Twilio doesn't retry-storm
      }
    }

    // GET /admin — dashboard page, served same-origin to avoid mobile
    // browsers blocking fetch() calls from a locally-opened file.
    if (request.method === "GET" && url.pathname === "/admin") {
      return new Response(ADMIN_DASHBOARD_HTML, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (!env.CHAT_KV) {
      return json({ error: "CHAT_KV binding missing" }, 500, headers);
    }

    // GET /api/analytics/summary?days=7
    if (request.method === "GET" && url.pathname === "/api/analytics/summary") {
      if (!checkAdminAuth(env, url)) return json({ error: "unauthorized" }, 401, headers);
      try {
        const summary = await getAnalyticsSummary(env, url.searchParams.get("days"));
        return json(summary, 200, headers);
      } catch (err) {
        return json({ error: err.message }, 502, headers);
      }
    }

    // POST /api/kb/upload  { title, text }
    if (request.method === "POST" && url.pathname === "/api/kb/upload") {
      if (!checkAdminAuth(env, url)) return json({ error: "unauthorized" }, 401, headers);
      let kbBody;
      try {
        kbBody = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400, headers);
      }
      const { title, text } = kbBody;
      if (!text || !text.trim()) return json({ error: "text required" }, 400, headers);
      try {
        const result = await kbUpload(env, title, text.trim());
        return json(result, 200, headers);
      } catch (err) {
        return json({ error: err.message }, 502, headers);
      }
    }

    // GET /api/kb/list — used by admin-dashboard.html
    if (request.method === "GET" && url.pathname === "/api/kb/list") {
      if (!checkAdminAuth(env, url)) return json({ error: "unauthorized" }, 401, headers);
      try {
        const result = await kbListDocs(env);
        return json(result, 200, headers);
      } catch (err) {
        return json({ error: err.message }, 502, headers);
      }
    }

    // POST /api/negotiate
    if (request.method === "POST" && url.pathname === "/api/negotiate") {
      let negBody;
      try {
        negBody = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400, headers);
      }
      const { productBrief, floorPrice, askPrice, buyerMessage, negotiationHistory } = negBody;
      if (!productBrief || !buyerMessage) return json({ error: "productBrief and buyerMessage required" }, 400, headers);
      try {
        const result = await runNegotiation(env, { productBrief, floorPrice, askPrice, buyerMessage, negotiationHistory });
        return json(result, 200, headers);
      } catch (err) {
        return json({ error: err.message }, 502, headers);
      }
    }

    // POST /api/generate/catalog  { brief, languages: ["en","bn","jp"] }
    if (request.method === "POST" && url.pathname === "/api/generate/catalog") {
      let catBody;
      try {
        catBody = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400, headers);
      }
      const { brief, languages } = catBody;
      if (!brief || !brief.trim()) return json({ error: "brief required" }, 400, headers);
      try {
        const result = await generateCatalogCopy(env, brief.trim(), languages);
        return json({ languages: result }, 200, headers);
      } catch (err) {
        return json({ error: err.message }, 502, headers);
      }
    }

    // POST /api/generate/demo-video/start  { productBrief, duration, resolution, aspectRatio }
    if (request.method === "POST" && url.pathname === "/api/generate/demo-video/start") {
      let demoBody;
      try {
        demoBody = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400, headers);
      }
      const { productBrief, duration, resolution, aspectRatio } = demoBody;
      if (!productBrief || !productBrief.trim()) return json({ error: "productBrief required" }, 400, headers);
      try {
        const prompt = await buildDemoVideoPrompt(env, productBrief.trim());
        const result = await startVideoGeneration(env, {
          prompt,
          duration: duration || 8,
          resolution,
          aspectRatio,
        });
        return json({ ...result, promptUsed: prompt }, 200, headers);
      } catch (err) {
        console.error("[/api/generate/demo-video/start]", err);
        return json({ error: err.message }, 502, headers);
      }
    }

    // POST /api/conversations/:id/react  { sessionId, messageIndex, emoji }
    if (request.method === "POST" && /\/api\/conversations\/[^/]+\/react$/.test(url.pathname)) {
      let reactBody;
      try {
        reactBody = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400, headers);
      }
      const id = url.pathname.split("/")[3];
      const { sessionId, messageIndex, emoji } = reactBody;
      if (!sessionId || typeof messageIndex !== "number") {
        return json({ error: "sessionId and messageIndex required" }, 400, headers);
      }
      try {
        await reactToMessage(env, sessionId, id, messageIndex, emoji);
        return json({ ok: true }, 200, headers);
      } catch (err) {
        return json({ error: err.message }, 502, headers);
      }
    }

    // POST /api/conversations/:id/share  { sessionId }  -> { shareId }
    if (request.method === "POST" && /\/api\/conversations\/[^/]+\/share$/.test(url.pathname)) {
      let shareBody;
      try {
        shareBody = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400, headers);
      }
      const id = url.pathname.split("/")[3];
      const { sessionId } = shareBody;
      if (!sessionId) return json({ error: "sessionId required" }, 400, headers);
      try {
        const shareId = await createShareLink(env, sessionId, id);
        return json({ shareId }, 200, headers);
      } catch (err) {
        return json({ error: err.message }, 502, headers);
      }
    }

    // GET /api/shared/:shareId  -> read-only conversation, polled by viewers
    if (request.method === "GET" && url.pathname.startsWith("/api/shared/")) {
      const shareId = url.pathname.split("/").pop();
      try {
        const conv = await getSharedConversation(env, shareId);
        return json(conv, 200, headers);
      } catch (err) {
        return json({ error: err.message }, 404, headers);
      }
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

    // Knowledge Base retrieval (Phase 2) — only kicks in if KB_VECTORIZE is
    // bound and something's been uploaded; otherwise this is a no-op and
    // chat behaves exactly as before.
    let effectiveSystem = system || SYSTEM_PROMPT;
    if (!hasImages) {
      const kbContext = await kbRetrieveContext(env, lastUser);
      if (kbContext) effectiveSystem = `${effectiveSystem}\n\nReference material you may use to answer (only if relevant):\n${kbContext}`;
    }

    const callOpts = { system: effectiveSystem, images };
    const requestStartedAt = Date.now();

    // Non-streaming
    if (!stream) {
      try {
        const result = await runWithFallback(env, messages, { ...callOpts, stream: false }, order);

        if (sessionId && conversationId) {
          const storedMessages = messagesForStorage(messages, images.length);
          const fullMessages = [...storedMessages, { role: "assistant", content: result.text }];
          await saveConversation(env, sessionId, conversationId, fullMessages);
        }
        await trackEvent(env, "message", {
          provider: result.providerUsed,
          question: lastUser,
          responseMs: Date.now() - requestStartedAt,
          channel: "web",
        });

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
        if (finalText) {
          await trackEvent(env, "message", {
            provider: order.find((name) => PROVIDERS[name]?.isConfigured(env)),
            question: lastUser,
            responseMs: Date.now() - requestStartedAt,
            channel: "web",
          });
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

/**
 * ==========================================================================
 * FUTURE: true real-time collaboration via Durable Objects
 * ==========================================================================
 * The lite "share link" above (polling) covers most needs. If you later
 * want actual live multiplayer (two people watching keystrokes appear),
 * this needs a Durable Object + WebSockets, which can't be pasted into the
 * dashboard editor — it requires `wrangler.toml` + `wrangler deploy` from a
 * terminal. Rough shape for later:
 *
 *   export class ConversationRoom {
 *     constructor(state, env) { this.state = state; this.sessions = []; }
 *     async fetch(request) {
 *       const pair = new WebSocketPair();
 *       const [client, server] = Object.values(pair);
 *       server.accept();
 *       this.sessions.push(server);
 *       server.addEventListener("message", (msg) => {
 *         for (const s of this.sessions) if (s !== server) s.send(msg.data);
 *       });
 *       return new Response(null, { status: 101, webSocket: client });
 *     }
 *   }
 *
 * wrangler.toml would need:
 *   [[durable_objects.bindings]]
 *   name = "CONVERSATION_ROOM"
 *   class_name = "ConversationRoom"
 * Ask me for the full implementation when you're ready to set this up via
 * wrangler CLI — it's roughly a day of work end-to-end.
 * ==========================================================================
 */
