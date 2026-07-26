/**
 * ==========================================================================
 * RAWx BOT Chat Widget — Step 6: personalities + export + voice chat
 * ==========================================================================
 * New in this version (Phase 1 "wow factor" features, on top of Step 4):
 *   - Bot Personality: a dropdown next to the provider select ("Default",
 *     "Professional", "Friendly", "Product Expert", "Fun"). Picking one just
 *     sends a different `system` prompt on each request — the backend
 *     already supports this (POST body `system` field overrides its
 *     default), so NO backend changes were needed for this feature.
 *     Selection persists in localStorage across reloads.
 *   - Conversation Export: a 💾 button next to Generate opens a small menu
 *     with three options — Markdown (.md), JSON (.json), and Print/Save as
 *     PDF (opens a clean printable window and triggers the browser's print
 *     dialog, so no PDF library/CDN dependency is needed). All three run
 *     entirely client-side from the in-memory `history` array — no backend
 *     endpoint involved.
 *   - Voice Chat: a 🎤 button next to the text input uses the browser's
 *     native SpeechRecognition API to transcribe speech into the input box
 *     (tap the EN/বাং button first to pick the recognition language). A
 *     🔈/🔊 header button toggles auto-read-aloud of assistant replies using
 *     the browser's native SpeechSynthesis API, and every assistant bubble
 *     also gets its own small 🔊 replay button. Both APIs are 100% free and
 *     built into the browser — no Google Cloud STT/TTS, no API key, no
 *     per-minute cost. Trade-off: browser support varies (best in Chrome;
 *     Bengali recognition quality depends on the device/OS voice packs) —
 *     the mic button quietly disables itself with an alert if the browser
 *     doesn't support it, so nothing breaks on unsupported browsers.
 * ==========================================================================
 * New in this version (on top of Step 3):
 *   - A ✨ button next to Search opens a Generate panel with three tabs:
 *     "Document" (pick Quotation / Spec Sheet / Product Copy, type a short
 *     brief, get back plain-text copy with a Copy button), "Image" (type a
 *     prompt, get back a generated image with a Download link), and "Video"
 *     (Grok Imagine — type a prompt, pick a duration, wait while it polls,
 *     get back a playable video). Video is billed per second by xAI and
 *     needs Imagine video access on that API key/account, separate from a
 *     SuperGrok consumer subscription.
 *   - All three call one-shot Worker endpoints (/api/generate/document,
 *     /api/generate/image, /api/generate/video/start + /status) — not part
 *     of the chat thread, nothing saved to conversation history.
 * ==========================================================================
 * New in this version (on top of Step 2):
 *   - A 🔍 button next to History/New chat opens a search panel.
 *   - Typing a query hits the Worker's /api/drive-search route and shows
 *     matching files (thumbnail + name) from your Google Drive folder.
 *   - Tapping a result opens it in Drive in a new tab.
 * ==========================================================================
 * Usage (unchanged):
 *   <script>
 *     window.MULTI_AI_ENDPOINT = "https://the-o.himon.workers.dev";
 *     window.MULTI_AI_STREAM = true;
 *   </script>
 *   <script src="chat-widget.js"></script>
 *
 * New in this version (on top of Step 1 — memory/sidebar/new chat):
 *   - A 📎 attach button next to the input opens a file picker (images only,
 *     up to 3 at a time, 4MB each — same limits the backend enforces).
 *   - Selected images show as small thumbnails above the input, each with
 *     an × to remove before sending.
 *   - On submit, images are base64-encoded and sent as a top-level `images`
 *     field on the request — NOT folded into the `history` array, so they
 *     are only ever sent once (the turn they're attached to) rather than
 *     being silently re-uploaded on every later message.
 *   - The sent user bubble shows a small image-count tag so it's clear a
 *     picture was attached, even though — per the backend's design — the
 *     image itself won't be there anymore if the conversation is reloaded
 *     later (only "[N image(s) attached]" persists).
 * ==========================================================================
 */
(function () {
  const ENDPOINT = window.MULTI_AI_ENDPOINT || "https://multi-ai-bot.example.workers.dev";
  const STREAM = window.MULTI_AI_STREAM !== false;

  const SESSION_KEY = "mab_session_id";
  const ACTIVE_CONV_KEY = "mab_active_conv_id";

  const MAX_IMAGES = 3;
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

  // ---------------------------------------------------------------------
  // Bot personalities — just alternate `system` prompts. The backend already
  // uses `system: system || SYSTEM_PROMPT` from the request body, so picking
  // a personality here is a pure frontend change, no Worker redeploy needed.
  // ---------------------------------------------------------------------
  const PERSONALITIES = {
    professional: {
      label: "Professional",
      prompt:
        "You are a formal, professional business assistant for HANDS & HEAD Group / RAWx, a garment/leather-goods/jute/textile export business with 25 years of experience exporting to Japan. Be concise, precise, and businesslike — suited for client-facing quotations and formal correspondence. Keep replies under 120 words unless the user asks for more detail.",
    },
    friendly: {
      label: "Friendly",
      prompt:
        "You are a warm, friendly, conversational assistant for HANDS & HEAD Group / RAWx. Chat casually and helpfully, like a knowledgeable friend. Keep replies under 120 words unless the user asks for more detail.",
    },
    expert: {
      label: "Product Expert",
      prompt:
        "You are a technical product expert for HANDS & HEAD Group / RAWx, a garment/leather-goods/jute/textile export business. Give detailed, technical, spec-accurate answers about materials, construction, and manufacturing. Stay accurate — use a placeholder in [brackets] rather than inventing a fact you don't have.",
    },
    fun: {
      label: "Fun",
      prompt:
        "You are an upbeat, fun, casual assistant for HANDS & HEAD Group / RAWx — enthusiastic startup energy, light humor, emojis welcome. Still be accurate and helpful. Keep replies under 120 words unless the user asks for more detail.",
    },
  };
  const PERSONALITY_KEY = "mab_personality";

  // Voice chat settings
  const VOICE_LANG_KEY = "mab_voice_lang";
  const AUTO_SPEAK_KEY = "mab_auto_speak";
  const VOICE_LANGS = ["en-US", "bn-BD"];
  const VOICE_LANG_LABELS = { "en-US": "EN", "bn-BD": "বাং" };

  function getOrCreateSessionId() {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  }

  const SESSION_ID = getOrCreateSessionId();

  const STYLE = `
  .mab-launcher{
    position:fixed; bottom:24px; right:24px; z-index:9999; width:58px; height:58px; border-radius:50%;
    background:#1a1a1a; border:1px solid #333; color:#fff; cursor:pointer;
    display:flex; align-items:center; justify-content:center; box-shadow:0 6px 20px rgba(0,0,0,.35);
    font-family: system-ui, sans-serif;
  }
  .mab-launcher:hover{ background:#2a2a2a; }
  .mab-panel{
    position:fixed; bottom:92px; right:24px; z-index:9999; width:380px; max-width:calc(100vw - 32px);
    max-height:560px; background:#fff; border:1px solid #ddd; border-radius:12px; overflow:hidden;
    display:none; flex-direction:column; box-shadow:0 16px 48px rgba(0,0,0,.25);
    font-family: system-ui, sans-serif;
  }
  .mab-panel.open{ display:flex; }
  .mab-head{ display:flex; flex-direction:column; gap:8px; padding:12px 16px; background:#1a1a1a; color:#fff; font-size:0.85rem; }
  .mab-head-top{ display:flex; justify-content:space-between; align-items:center; gap:8px; }
  .mab-head-tools{ display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
  .mab-head-actions{ display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
  .mab-icon-btn{ background:none; border:none; color:#ddd; cursor:pointer; font-size:0.92rem; padding:2px 4px; line-height:1; }
  .mab-icon-btn:hover{ color:#fff; }
  .mab-head select{ background:#2a2a2a; color:#fff; border:1px solid #444; font-size:0.72rem; border-radius:6px; padding:4px 6px; }
  .mab-close{ background:none; border:none; color:#bbb; cursor:pointer; font-size:1rem; }
  .mab-body{ flex:1; display:flex; overflow:hidden; min-height:0; }
  .mab-messages{ flex:1; overflow-y:auto; padding:14px 16px; display:flex; flex-direction:column; gap:10px; min-height:200px; background:#fafafa; }
  .mab-msg{ font-size:0.88rem; line-height:1.45; padding:9px 13px; border-radius:10px; max-width:85%; white-space:pre-wrap; }
  .mab-msg.user{ align-self:flex-end; background:#1a1a1a; color:#fff; }
  .mab-msg.assistant{ align-self:flex-start; background:#eee; color:#111; }
  .mab-msg.assistant .mab-provider-tag{ display:block; font-size:0.62rem; opacity:0.55; margin-bottom:3px; text-transform:uppercase; letter-spacing:0.05em; }
  .mab-msg .mab-img-tag{ display:inline-block; font-size:0.68rem; opacity:0.75; margin-top:4px; }

  .mab-attach-preview{
    display:flex; gap:8px; padding:10px 14px 0; flex-wrap:wrap;
  }
  .mab-attach-thumb{
    position:relative; width:52px; height:52px; border-radius:8px; overflow:hidden; border:1px solid #ddd;
  }
  .mab-attach-thumb img{ width:100%; height:100%; object-fit:cover; display:block; }
  .mab-attach-thumb button{
    position:absolute; top:-6px; right:-6px; width:18px; height:18px; border-radius:50%;
    background:#1a1a1a; color:#fff; border:none; font-size:0.65rem; line-height:1; cursor:pointer;
    display:flex; align-items:center; justify-content:center;
  }
  .mab-attach-error{ padding:6px 14px 0; font-size:0.72rem; color:#c81d11; }

  .mab-form{ display:flex; border-top:1px solid #eee; align-items:center; }
  .mab-attach-btn{
    background:none; border:none; cursor:pointer; font-size:1rem; padding:0 10px; color:#555; flex-shrink:0;
  }
  .mab-attach-btn:hover{ color:#111; }
  .mab-form input[type="text"]{ flex:1; border:none; padding:12px 6px; font-size:0.88rem; outline:none; }
  .mab-form button[type="submit"]{ background:#1a1a1a; color:#fff; border:none; padding:0 18px; height:100%; cursor:pointer; font-size:0.8rem; }

  .mab-sidebar{
    width:100%; background:#fff; overflow-y:auto; display:flex; flex-direction:column;
  }
  .mab-sidebar-new{
    margin:12px; padding:10px 12px; background:#1a1a1a; color:#fff; border:none; border-radius:8px;
    font-size:0.82rem; cursor:pointer; text-align:left;
  }
  .mab-sidebar-list{ flex:1; overflow-y:auto; display:flex; flex-direction:column; }
  .mab-sidebar-item{
    padding:10px 14px; border-bottom:1px solid #eee; cursor:pointer; font-size:0.8rem; color:#222;
    display:flex; flex-direction:column; gap:2px;
  }
  .mab-sidebar-item:hover{ background:#f2f2f2; }
  .mab-sidebar-item .mab-conv-title{ font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .mab-sidebar-item .mab-conv-time{ font-size:0.66rem; color:#888; }
  .mab-sidebar-empty{ padding:20px 16px; font-size:0.78rem; color:#888; text-align:center; }

  .mab-search-panel{
    width:100%; background:#fff; overflow-y:auto; display:flex; flex-direction:column;
  }
  .mab-search-bar{ display:flex; gap:8px; padding:12px; border-bottom:1px solid #eee; }
  .mab-search-bar input{
    flex:1; border:1px solid #ddd; border-radius:6px; padding:8px 10px; font-size:0.82rem; outline:none;
  }
  .mab-search-bar button{
    background:#1a1a1a; color:#fff; border:none; border-radius:6px; padding:0 14px; font-size:0.78rem; cursor:pointer;
  }
  .mab-search-results{
    flex:1; overflow-y:auto; padding:12px; display:grid; grid-template-columns:1fr 1fr; gap:10px; align-content:start;
  }
  .mab-search-item{
    border:1px solid #eee; border-radius:8px; overflow:hidden; cursor:pointer; text-decoration:none; color:#222;
    display:flex; flex-direction:column; background:#fafafa;
  }
  .mab-search-item .mab-search-thumb{
    width:100%; height:90px; background:#eee; display:flex; align-items:center; justify-content:center; overflow:hidden;
  }
  .mab-search-item .mab-search-thumb img{ width:100%; height:100%; object-fit:cover; }
  .mab-search-item .mab-search-name{
    font-size:0.68rem; padding:6px 8px; line-height:1.3; word-break:break-word;
  }
  .mab-search-empty{ padding:24px 16px; font-size:0.78rem; color:#888; text-align:center; grid-column:1 / -1; }

  .mab-generate-panel{ width:100%; background:#fff; overflow-y:auto; display:flex; flex-direction:column; }
  .mab-gen-tabs{ display:flex; border-bottom:1px solid #eee; }
  .mab-gen-tab{
    flex:1; background:none; border:none; padding:10px; font-size:0.78rem; cursor:pointer; color:#888;
    border-bottom:2px solid transparent;
  }
  .mab-gen-tab.active{ color:#111; border-bottom-color:#1a1a1a; font-weight:600; }
  .mab-gen-view{ display:flex; flex-direction:column; gap:8px; padding:12px; }
  .mab-gen-view select, .mab-gen-view textarea{
    width:100%; border:1px solid #ddd; border-radius:6px; padding:8px 10px; font-size:0.82rem;
    font-family: inherit; outline:none; resize:vertical;
  }
  .mab-gen-view button{
    background:#1a1a1a; color:#fff; border:none; border-radius:6px; padding:9px; font-size:0.8rem; cursor:pointer;
  }
  .mab-gen-view button:disabled{ opacity:0.5; cursor:default; }
  .mab-gen-doc-status, .mab-gen-img-status{ font-size:0.74rem; color:#888; min-height:1em; }
  .mab-gen-doc-output-wrap{ display:flex; flex-direction:column; gap:8px; }
  .mab-gen-doc-output{ background:#fafafa; }
  .mab-gen-img-result{ display:flex; flex-direction:column; gap:8px; align-items:flex-start; }
  .mab-gen-img-result img{ max-width:100%; border-radius:8px; border:1px solid #eee; }
  .mab-gen-img-result a{ font-size:0.78rem; color:#1a1a1a; }
  .mab-gen-vid-note{ font-size:0.68rem; color:#999; }
  .mab-gen-vid-result{ display:flex; flex-direction:column; gap:8px; align-items:flex-start; }
  .mab-gen-vid-result video{ max-width:100%; border-radius:8px; border:1px solid #eee; }
  .mab-gen-vid-result a{ font-size:0.78rem; color:#1a1a1a; }

  .mab-head select.mab-personality{ max-width:88px; }
  .mab-export-wrap{ position:relative; display:inline-flex; }
  .mab-export-menu{
    position:absolute; top:30px; left:0; background:#fff; border:1px solid #ddd; border-radius:8px;
    box-shadow:0 10px 28px rgba(0,0,0,.25); display:none; flex-direction:column; z-index:10000;
    overflow:hidden; min-width:170px;
  }
  .mab-export-menu.open{ display:flex; }
  .mab-export-menu button{
    background:none; border:none; text-align:left; padding:9px 14px; font-size:0.78rem; cursor:pointer;
    color:#222; font-family:inherit; white-space:nowrap;
  }
  .mab-export-menu button:hover{ background:#f2f2f2; }
  .mab-export-menu button:disabled{ opacity:0.45; cursor:default; }

  .mab-speak-toggle.on{ color:#4caf50; }
  .mab-voice-lang-btn{
    background:none; border:1px solid #ccc; border-radius:6px; cursor:pointer; font-size:0.66rem;
    padding:3px 6px; color:#555; flex-shrink:0; margin-right:2px; font-family:inherit;
  }
  .mab-voice-lang-btn:hover{ border-color:#999; }
  .mab-mic-btn{
    background:none; border:none; cursor:pointer; font-size:1rem; padding:0 8px; color:#555; flex-shrink:0;
  }
  .mab-mic-btn:hover{ color:#111; }
  .mab-mic-btn.listening{ color:#c81d11; animation: mab-pulse 1s infinite; }
  @keyframes mab-pulse{ 0%{ opacity:1; } 50%{ opacity:0.35; } 100%{ opacity:1; } }

  .mab-speak-btn{
    display:inline-block; background:none; border:none; cursor:pointer; font-size:0.72rem;
    margin-left:6px; opacity:0.55; vertical-align:middle; padding:0;
  }
  .mab-speak-btn:hover{ opacity:1; }

  /* ---- Phase 3: timestamps + reading time + reactions ---- */
  .mab-msg-meta{ display:flex; align-items:center; gap:6px; font-size:0.62rem; opacity:0.5; margin-top:4px; }
  .mab-reactions{ display:flex; gap:4px; margin-top:6px; }
  .mab-react-btn{
    background:none; border:1px solid transparent; border-radius:6px; cursor:pointer;
    font-size:0.82rem; padding:1px 4px; opacity:0.55; line-height:1.3;
  }
  .mab-react-btn:hover{ opacity:1; background:rgba(0,0,0,0.06); }
  .mab-react-btn.active{ opacity:1; border-color:currentColor; background:rgba(0,0,0,0.08); }

  /* ---- Phase 3: chat themes ---- */
  .mab-panel.theme-brand{ background:#0d0d0c; border-color:rgba(236,231,220,0.32); }
  .mab-panel.theme-brand .mab-head{ background:#0d0d0c; border-bottom:1px solid rgba(236,231,220,0.18); }
  .mab-panel.theme-brand .mab-messages{ background:#161615; }
  .mab-panel.theme-brand .mab-msg.assistant{ background:#0d0d0c; color:#ece7dc; border:1px solid rgba(236,231,220,0.14); }
  .mab-panel.theme-brand .mab-msg.user{ background:#c81d11; color:#ece7dc; }
  .mab-panel.theme-brand .mab-form{ border-top:1px solid rgba(236,231,220,0.18); background:#0d0d0c; }
  .mab-panel.theme-brand .mab-form input[type="text"]{ background:#0d0d0c; color:#ece7dc; }
  .mab-panel.theme-light{ background:#fff; }
  .mab-panel.theme-light .mab-head{ background:#f4f4f2; color:#111; }
  .mab-panel.theme-light .mab-head .mab-icon-btn{ color:#555; }
  .mab-panel.theme-light .mab-head select{ background:#fff; color:#111; border:1px solid #ccc; }
  .mab-panel.theme-light .mab-close{ color:#555; }
  .mab-theme-btn{
    background:none; border:none; cursor:pointer; font-size:0.9rem; padding:2px 4px; color:#ddd;
  }
  .mab-panel.theme-light .mab-theme-btn{ color:#555; }

  /* ---- Phase 5: gamification badge ---- */
  .mab-badge{
    font-size:0.62rem; padding:2px 7px; border-radius:10px; background:rgba(255,255,255,0.14);
    color:#fff; letter-spacing:0.03em; white-space:nowrap;
  }
  .mab-panel.theme-light .mab-badge{ background:#eee; color:#333; }

  /* ---- Phase 2/3: share banner (read-only shared view) ---- */
  .mab-share-banner{
    background:#fff7e6; color:#7a5b00; font-size:0.72rem; padding:8px 14px; text-align:center;
    border-bottom:1px solid #f0dca0;
  }

  /* ---- new Generate tabs: negotiate / catalog / knowledge base ---- */
  .mab-gen-neg-log{ display:flex; flex-direction:column; gap:6px; max-height:160px; overflow-y:auto; }
  .mab-gen-neg-log .mab-neg-line{ font-size:0.78rem; padding:6px 9px; border-radius:8px; background:#f2f2f2; }
  .mab-gen-neg-line-buyer{ background:#e8f0ff; }
  .mab-gen-neg-price{ font-size:0.72rem; color:#666; }
  .mab-gen-catalog-result{ display:flex; flex-direction:column; gap:10px; }
  .mab-gen-catalog-lang{ border:1px solid #eee; border-radius:8px; padding:8px 10px; background:#fafafa; }
  .mab-gen-catalog-lang h4{ font-size:0.76rem; margin-bottom:4px; }
  .mab-gen-catalog-lang p{ font-size:0.78rem; line-height:1.4; white-space:pre-wrap; margin-bottom:4px; }
  .mab-gen-catalog-lang .mab-hashtags{ font-size:0.7rem; color:#1a1a1a; opacity:0.7; }
  .mab-gen-kb-note{ font-size:0.7rem; color:#999; }
  .mab-price-row{ display:flex; gap:8px; }
  .mab-price-row input{
    flex:1; border:1px solid #ddd; border-radius:6px; padding:8px 10px; font-size:0.82rem; outline:none;
  }
  `;

  function injectStyle() {
    const s = document.createElement("style");
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function buildUI() {
    const launcher = document.createElement("button");
    launcher.className = "mab-launcher";
    launcher.setAttribute("aria-label", "Open chat");
    launcher.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16v12H7l-3 3z"/></svg>`;
    document.body.appendChild(launcher);

    const panel = document.createElement("div");
    panel.className = "mab-panel";
    panel.innerHTML = `
      <div class="mab-head">
        <div class="mab-head-top">
          <span class="mab-head-title">Ask us anything</span>
          <div class="mab-head-actions">
            <span class="mab-badge" title="Chats this session">&#11088; 0</span>
            <button type="button" class="mab-close" aria-label="Close">&times;</button>
          </div>
        </div>
        <div class="mab-head-tools">
          <div class="mab-head-actions">
            <button type="button" class="mab-icon-btn mab-history-toggle" aria-label="History" title="History">&#9776;</button>
            <button type="button" class="mab-icon-btn mab-search-toggle" aria-label="Search" title="Search">&#128269;</button>
            <button type="button" class="mab-icon-btn mab-generate-toggle" aria-label="Generate" title="Generate">&#10024;</button>
            <span class="mab-export-wrap">
              <button type="button" class="mab-icon-btn mab-export-toggle" aria-label="Export conversation" title="Export conversation">&#128190;</button>
              <div class="mab-export-menu">
                <button type="button" class="mab-export-md">Export as Markdown (.md)</button>
                <button type="button" class="mab-export-json">Export as JSON (.json)</button>
                <button type="button" class="mab-export-pdf">Print / Save as PDF</button>
              </div>
            </span>
            <button type="button" class="mab-icon-btn mab-speak-toggle" aria-label="Auto-read replies aloud" title="Auto-read replies aloud">&#128264;</button>
            <button type="button" class="mab-icon-btn mab-share-toggle" aria-label="Share conversation" title="Share conversation (read-only link)">&#128279;</button>
            <button type="button" class="mab-theme-btn" aria-label="Change theme" title="Change chat theme">&#127912;</button>
            <button type="button" class="mab-icon-btn mab-new-chat" aria-label="New chat" title="New chat">+</button>
          </div>
          <div class="mab-head-actions">
            <select class="mab-personality" title="Bot personality">
              <option value="">Default</option>
              <option value="professional">Professional</option>
              <option value="friendly">Friendly</option>
              <option value="expert">Product Expert</option>
              <option value="fun">Fun</option>
            </select>
            <select class="mab-provider">
              <option value="">Auto</option>
              <option value="claude">Claude</option>
              <option value="gemini">Gemini</option>
              <option value="grok">Grok</option>
              <option value="openai">ChatGPT</option>
            </select>
          </div>
        </div>
      </div>
      <div class="mab-share-banner" style="display:none;"></div>
      <div class="mab-body">
        <div class="mab-sidebar" style="display:none;">
          <button type="button" class="mab-sidebar-new">+ New conversation</button>
          <div class="mab-sidebar-list"></div>
        </div>
        <div class="mab-search-panel" style="display:none;">
          <div class="mab-search-bar">
            <input type="text" class="mab-search-input" placeholder="Search files...">
            <button type="button" class="mab-search-btn">Search</button>
          </div>
          <div class="mab-search-results"></div>
        </div>
        <div class="mab-generate-panel" style="display:none;">
          <div class="mab-gen-tabs">
            <button type="button" class="mab-gen-tab active" data-tab="document">Document</button>
            <button type="button" class="mab-gen-tab" data-tab="image">Image</button>
            <button type="button" class="mab-gen-tab" data-tab="video">Video</button>
            <button type="button" class="mab-gen-tab" data-tab="negotiate">Negotiate</button>
            <button type="button" class="mab-gen-tab" data-tab="catalog">Catalog</button>
            <button type="button" class="mab-gen-tab" data-tab="kb">Knowledge</button>
          </div>
          <div class="mab-gen-view mab-gen-doc">
            <select class="mab-gen-doctype">
              <option value="quotation">Quotation</option>
              <option value="specsheet">Spec Sheet</option>
              <option value="productcopy">Product Copy</option>
            </select>
            <textarea class="mab-gen-brief" rows="3" placeholder="Describe the product — e.g. 'genuine leather wallet, 3 colors, 500 pcs, for a Japan buyer'"></textarea>
            <button type="button" class="mab-gen-doc-btn">Generate</button>
            <div class="mab-gen-doc-status"></div>
            <div class="mab-gen-doc-output-wrap" style="display:none;">
              <textarea class="mab-gen-doc-output" rows="8" readonly></textarea>
              <button type="button" class="mab-gen-doc-copy">Copy text</button>
            </div>
          </div>
          <div class="mab-gen-view mab-gen-img" style="display:none;">
            <textarea class="mab-gen-img-prompt" rows="3" placeholder="Describe the image — e.g. 'brown leather messenger bag on a plain white studio background'"></textarea>
            <button type="button" class="mab-gen-img-btn">Generate</button>
            <div class="mab-gen-img-status"></div>
            <div class="mab-gen-img-result"></div>
          </div>
          <div class="mab-gen-view mab-gen-vid" style="display:none;">
            <label style="font-size:0.76rem; display:flex; gap:6px; align-items:center;">
              <input type="checkbox" class="mab-gen-vid-demo-mode"> Product demo mode — auto-write the marketing script from a short brief
            </label>
            <textarea class="mab-gen-vid-prompt" rows="3" placeholder="Describe the video — e.g. 'slow pan across a rack of leather jackets in a bright showroom'"></textarea>
            <select class="mab-gen-vid-duration">
              <option value="5">5 seconds</option>
              <option value="6" selected>6 seconds</option>
              <option value="8">8 seconds</option>
              <option value="10">10 seconds</option>
            </select>
            <div class="mab-gen-vid-note">Billed per second by xAI (~$0.05/sec) — keep it short while testing.</div>
            <button type="button" class="mab-gen-vid-btn">Generate</button>
            <div class="mab-gen-vid-status"></div>
            <div class="mab-gen-vid-result"></div>
          </div>
          <div class="mab-gen-view mab-gen-neg" style="display:none;">
            <textarea class="mab-gen-neg-brief" rows="2" placeholder="Product brief — e.g. '500 pcs genuine leather wallets, 3 colors'"></textarea>
            <div class="mab-price-row">
              <input type="number" class="mab-gen-neg-floor" placeholder="Floor price (internal, hidden)">
              <input type="number" class="mab-gen-neg-ask" placeholder="Asking price">
            </div>
            <div class="mab-gen-neg-log"></div>
            <textarea class="mab-gen-neg-buyer" rows="2" placeholder="Buyer's message — e.g. 'Can you do $4.20/pc for 500 units?'"></textarea>
            <button type="button" class="mab-gen-neg-btn">Send</button>
            <div class="mab-gen-neg-status"></div>
          </div>
          <div class="mab-gen-view mab-gen-catalog" style="display:none;">
            <textarea class="mab-gen-catalog-brief" rows="3" placeholder="Describe the product — e.g. 'jute tote bag, natural fiber, handwoven'"></textarea>
            <label style="font-size:0.76rem;"><input type="checkbox" class="mab-gen-catalog-lang" value="en" checked> English</label>
            <label style="font-size:0.76rem;"><input type="checkbox" class="mab-gen-catalog-lang" value="bn"> Bengali</label>
            <label style="font-size:0.76rem;"><input type="checkbox" class="mab-gen-catalog-lang" value="jp"> Japanese</label>
            <button type="button" class="mab-gen-catalog-btn">Generate</button>
            <div class="mab-gen-catalog-status"></div>
            <div class="mab-gen-catalog-result"></div>
          </div>
          <div class="mab-gen-view mab-gen-kb" style="display:none;">
            <div class="mab-gen-kb-note">Admin: paste text from past quotations, spec sheets, or price lists so the bot can answer from your real data instead of generic replies. Requires a Vectorize index bound as KB_VECTORIZE on the Worker.</div>
            <input type="text" class="mab-gen-kb-title" placeholder="Title — e.g. 'Q3 2026 Leather Price List'">
            <textarea class="mab-gen-kb-text" rows="5" placeholder="Paste the content here..."></textarea>
            <button type="button" class="mab-gen-kb-btn">Add to Knowledge Base</button>
            <div class="mab-gen-kb-status"></div>
          </div>
        </div>
        <div class="mab-messages"></div>
      </div>
      <div class="mab-attach-preview"></div>
      <div class="mab-attach-error"></div>
      <form class="mab-form">
        <button type="button" class="mab-attach-btn" aria-label="Attach image" title="Attach image">&#128206;</button>
        <input type="file" class="mab-file-input" accept="image/jpeg,image/png,image/webp,image/gif" multiple style="display:none">
        <button type="button" class="mab-voice-lang-btn" title="Voice language (tap to switch)">EN</button>
        <button type="button" class="mab-mic-btn" aria-label="Voice input" title="Speak your message">&#127908;</button>
        <input type="text" placeholder="Type a message..." required>
        <button type="submit">Send</button>
      </form>
    `;
    document.body.appendChild(panel);

    launcher.addEventListener("click", () => panel.classList.toggle("open"));
    panel.querySelector(".mab-close").addEventListener("click", () => panel.classList.remove("open"));

    return panel;
  }

  const REACTION_EMOJIS = ["👍", "❤️", "🔥", "😂"];

  function readingTimeLabel(text) {
    const words = (text || "").trim().split(/\s+/).filter(Boolean).length;
    if (words === 0) return "";
    const mins = words / 200;
    return mins < 1 ? "<1 min read" : `${Math.ceil(mins)} min read`;
  }

  function addMessage(container, role, text, providerUsed, imageCount, opts) {
    opts = opts || {};
    const div = document.createElement("div");
    div.className = `mab-msg ${role}`;
    let html = "";
    if (role === "assistant" && providerUsed) {
      html += `<span class="mab-provider-tag">${providerUsed}</span>`;
    }
    html += escapeHtml(text);
    if (role === "user" && imageCount) {
      html += `<span class="mab-img-tag"> 📎 ${imageCount} image${imageCount > 1 ? "s" : ""}</span>`;
    }
    div.innerHTML = html;

    // Phase 3: timestamp + reading time.
    const ts = opts.timestamp || Date.now();
    const meta = document.createElement("div");
    meta.className = "mab-msg-meta";
    const readTime = role === "assistant" ? readingTimeLabel(text) : "";
    meta.textContent = readTime ? `${formatTime(ts)} · ${readTime}` : formatTime(ts);
    div.appendChild(meta);

    if (role === "assistant" && text) {
      addSpeakButton(div, text);
    }

    // Phase 3: reaction buttons — only wired up when the caller supplies
    // onReact (i.e. we know this message's index + have somewhere to save it).
    if (role === "assistant" && typeof opts.onReact === "function") {
      const row = document.createElement("div");
      row.className = "mab-reactions";
      REACTION_EMOJIS.forEach((emoji) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mab-react-btn" + (opts.reaction === emoji ? " active" : "");
        btn.textContent = emoji;
        btn.addEventListener("click", () => {
          const isActive = btn.classList.contains("active");
          row.querySelectorAll(".mab-react-btn").forEach((b) => b.classList.remove("active"));
          if (!isActive) btn.classList.add("active");
          opts.onReact(isActive ? null : emoji);
        });
        row.appendChild(btn);
      });
      div.appendChild(row);
    }

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
  }

  // Reads text aloud with the browser's native SpeechSynthesis API (free,
  // no API key). Silently no-ops if the browser doesn't support it.
  function speak(text) {
    if (!("speechSynthesis" in window) || !text) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = localStorage.getItem(VOICE_LANG_KEY) || "en-US";
      window.speechSynthesis.speak(utter);
    } catch (err) {
      console.warn("[rawx-bot-widget] speak failed", err);
    }
  }

  // Adds a small 🔊 replay button to an assistant bubble, if TTS is supported.
  function addSpeakButton(bubbleEl, text) {
    if (!("speechSynthesis" in window)) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mab-speak-btn";
    btn.setAttribute("aria-label", "Read aloud");
    btn.title = "Read aloud";
    btn.textContent = "🔊";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      speak(text);
    });
    bubbleEl.appendChild(btn);
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  // Reads a File as base64 (no data: prefix), resolving { mediaType, data, previewUrl }.
  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result || "";
        const commaIdx = result.indexOf(",");
        resolve({
          mediaType: file.type,
          data: commaIdx >= 0 ? result.slice(commaIdx + 1) : result,
          previewUrl: result,
          name: file.name,
        });
      };
      reader.onerror = () => reject(new Error("Could not read file"));
      reader.readAsDataURL(file);
    });
  }

  function init() {
    injectStyle();
    const panel = buildUI();
    const messagesEl = panel.querySelector(".mab-messages");
    const sidebarEl = panel.querySelector(".mab-sidebar");
    const sidebarListEl = panel.querySelector(".mab-sidebar-list");
    const historyToggle = panel.querySelector(".mab-history-toggle");
    const searchPanelEl = panel.querySelector(".mab-search-panel");
    const searchToggle = panel.querySelector(".mab-search-toggle");
    const searchInput = panel.querySelector(".mab-search-input");
    const searchBtn = panel.querySelector(".mab-search-btn");
    const searchResultsEl = panel.querySelector(".mab-search-results");
    const generatePanelEl = panel.querySelector(".mab-generate-panel");
    const generateToggle = panel.querySelector(".mab-generate-toggle");
    const genTabs = panel.querySelectorAll(".mab-gen-tab");
    const genDocView = panel.querySelector(".mab-gen-doc");
    const genImgView = panel.querySelector(".mab-gen-img");
    const genDocType = panel.querySelector(".mab-gen-doctype");
    const genBrief = panel.querySelector(".mab-gen-brief");
    const genDocBtn = panel.querySelector(".mab-gen-doc-btn");
    const genDocStatus = panel.querySelector(".mab-gen-doc-status");
    const genDocOutputWrap = panel.querySelector(".mab-gen-doc-output-wrap");
    const genDocOutput = panel.querySelector(".mab-gen-doc-output");
    const genDocCopy = panel.querySelector(".mab-gen-doc-copy");
    const genImgPrompt = panel.querySelector(".mab-gen-img-prompt");
    const genImgBtn = panel.querySelector(".mab-gen-img-btn");
    const genImgStatus = panel.querySelector(".mab-gen-img-status");
    const genImgResult = panel.querySelector(".mab-gen-img-result");
    const genVidView = panel.querySelector(".mab-gen-vid");
    const genVidPrompt = panel.querySelector(".mab-gen-vid-prompt");
    const genVidDuration = panel.querySelector(".mab-gen-vid-duration");
    const genVidDemoMode = panel.querySelector(".mab-gen-vid-demo-mode");
    const genVidBtn = panel.querySelector(".mab-gen-vid-btn");
    const genVidStatus = panel.querySelector(".mab-gen-vid-status");
    const genVidResult = panel.querySelector(".mab-gen-vid-result");
    const genNegView = panel.querySelector(".mab-gen-neg");
    const genNegBrief = panel.querySelector(".mab-gen-neg-brief");
    const genNegFloor = panel.querySelector(".mab-gen-neg-floor");
    const genNegAsk = panel.querySelector(".mab-gen-neg-ask");
    const genNegLog = panel.querySelector(".mab-gen-neg-log");
    const genNegBuyer = panel.querySelector(".mab-gen-neg-buyer");
    const genNegBtn = panel.querySelector(".mab-gen-neg-btn");
    const genNegStatus = panel.querySelector(".mab-gen-neg-status");
    const genCatalogView = panel.querySelector(".mab-gen-catalog");
    const genCatalogBrief = panel.querySelector(".mab-gen-catalog-brief");
    const genCatalogLangs = panel.querySelectorAll(".mab-gen-catalog-lang");
    const genCatalogBtn = panel.querySelector(".mab-gen-catalog-btn");
    const genCatalogStatus = panel.querySelector(".mab-gen-catalog-status");
    const genCatalogResult = panel.querySelector(".mab-gen-catalog-result");
    const genKbView = panel.querySelector(".mab-gen-kb");
    const genKbTitle = panel.querySelector(".mab-gen-kb-title");
    const genKbText = panel.querySelector(".mab-gen-kb-text");
    const genKbBtn = panel.querySelector(".mab-gen-kb-btn");
    const genKbStatus = panel.querySelector(".mab-gen-kb-status");
    const themeBtn = panel.querySelector(".mab-theme-btn");
    const shareToggle = panel.querySelector(".mab-share-toggle");
    const shareBanner = panel.querySelector(".mab-share-banner");
    const badgeEl = panel.querySelector(".mab-badge");
    const newChatBtn = panel.querySelector(".mab-new-chat");
    const sidebarNewBtn = panel.querySelector(".mab-sidebar-new");
    const form = panel.querySelector(".mab-form");
    const input = form.querySelector("input[type='text']");
    const providerSelect = panel.querySelector(".mab-provider");
    const personalitySelect = panel.querySelector(".mab-personality");
    const attachBtn = panel.querySelector(".mab-attach-btn");
    const fileInput = panel.querySelector(".mab-file-input");
    const previewEl = panel.querySelector(".mab-attach-preview");
    const attachErrorEl = panel.querySelector(".mab-attach-error");
    const exportToggle = panel.querySelector(".mab-export-toggle");
    const exportMenu = panel.querySelector(".mab-export-menu");
    const exportMdBtn = panel.querySelector(".mab-export-md");
    const exportJsonBtn = panel.querySelector(".mab-export-json");
    const exportPdfBtn = panel.querySelector(".mab-export-pdf");
    const speakToggle = panel.querySelector(".mab-speak-toggle");
    const voiceLangBtn = panel.querySelector(".mab-voice-lang-btn");
    const micBtn = panel.querySelector(".mab-mic-btn");

    let history = [];
    let conversationId = localStorage.getItem(ACTIVE_CONV_KEY) || null;
    let pendingImages = []; // { mediaType, data, previewUrl, name }

    // ---- Bot personality: restore saved choice, persist on change ----
    personalitySelect.value = localStorage.getItem(PERSONALITY_KEY) || "";
    personalitySelect.addEventListener("change", () => {
      localStorage.setItem(PERSONALITY_KEY, personalitySelect.value);
    });
    function getPersonalitySystemPrompt() {
      const key = personalitySelect.value;
      return key && PERSONALITIES[key] ? PERSONALITIES[key].prompt : undefined;
    }

    // ---- Conversation export ----
    function conversationToMarkdown() {
      const lines = [`# RAWx Bot Conversation`, `_Exported ${new Date().toLocaleString()}_`, ""];
      history.forEach((m) => {
        lines.push(m.role === "user" ? "**You:**" : "**RAWx Bot:**", m.content, "");
      });
      return lines.join("\n");
    }

    function downloadBlob(filename, content, mime) {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    function closeExportMenu() {
      exportMenu.classList.remove("open");
    }

    exportToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      exportMenu.classList.toggle("open");
    });
    document.addEventListener("click", (e) => {
      if (!exportMenu.contains(e.target) && e.target !== exportToggle) closeExportMenu();
    });

    exportMdBtn.addEventListener("click", () => {
      closeExportMenu();
      if (history.length === 0) return;
      downloadBlob(`rawx-chat-${Date.now()}.md`, conversationToMarkdown(), "text/markdown");
    });

    exportJsonBtn.addEventListener("click", () => {
      closeExportMenu();
      if (history.length === 0) return;
      downloadBlob(
        `rawx-chat-${Date.now()}.json`,
        JSON.stringify({ exportedAt: new Date().toISOString(), messages: history }, null, 2),
        "application/json"
      );
    });

    exportPdfBtn.addEventListener("click", () => {
      closeExportMenu();
      if (history.length === 0) return;
      const w = window.open("", "_blank");
      if (!w) {
        alert("Please allow pop-ups for this site to export as PDF.");
        return;
      }
      const rows = history
        .map(
          (m) =>
            `<div style="margin-bottom:14px;"><strong>${m.role === "user" ? "You" : "RAWx Bot"}:</strong>` +
            `<div style="white-space:pre-wrap;margin-top:2px;">${escapeHtml(m.content)}</div></div>`
        )
        .join("");
      w.document.write(
        `<html><head><title>RAWx Bot Conversation</title><meta charset="utf-8">` +
          `<style>body{font-family:system-ui,sans-serif;padding:24px;max-width:700px;margin:0 auto;color:#111;}` +
          `h1{font-size:1.15rem;} .mab-print-meta{color:#888;font-size:0.78rem;margin-bottom:16px;}</style>` +
          `</head><body><h1>RAWx Bot Conversation</h1>` +
          `<div class="mab-print-meta">Exported ${new Date().toLocaleString()}</div>${rows}</body></html>`
      );
      w.document.close();
      w.focus();
      setTimeout(() => w.print(), 300);
    });

    // ---- Voice chat: text-to-speech (auto-read toggle) ----
    let autoSpeak = localStorage.getItem(AUTO_SPEAK_KEY) === "1";
    function renderSpeakToggle() {
      speakToggle.classList.toggle("on", autoSpeak);
      speakToggle.innerHTML = autoSpeak ? "&#128266;" : "&#128264;";
    }
    renderSpeakToggle();
    speakToggle.addEventListener("click", () => {
      autoSpeak = !autoSpeak;
      localStorage.setItem(AUTO_SPEAK_KEY, autoSpeak ? "1" : "0");
      renderSpeakToggle();
      if (!autoSpeak && "speechSynthesis" in window) window.speechSynthesis.cancel();
    });

    // ---- Voice chat: language toggle (used by both mic input and TTS) ----
    function currentVoiceLang() {
      return localStorage.getItem(VOICE_LANG_KEY) || VOICE_LANGS[0];
    }
    function renderVoiceLangBtn() {
      voiceLangBtn.textContent = VOICE_LANG_LABELS[currentVoiceLang()] || "EN";
    }
    renderVoiceLangBtn();
    voiceLangBtn.addEventListener("click", () => {
      const idx = VOICE_LANGS.indexOf(currentVoiceLang());
      const next = VOICE_LANGS[(idx + 1) % VOICE_LANGS.length];
      localStorage.setItem(VOICE_LANG_KEY, next);
      renderVoiceLangBtn();
      if (recognition) recognition.lang = next;
    });

    // ---- Voice chat: speech-to-text (mic button) ----
    // Uses the browser's native SpeechRecognition API — free, no backend
    // change, no API key. Support varies by browser (best in Chrome); the
    // button disables itself gracefully where it isn't available.
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition = null;
    let recognizing = false;
    if (SpeechRecognitionCtor) {
      recognition = new SpeechRecognitionCtor();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = currentVoiceLang();
      recognition.addEventListener("start", () => {
        recognizing = true;
        micBtn.classList.add("listening");
      });
      recognition.addEventListener("end", () => {
        recognizing = false;
        micBtn.classList.remove("listening");
      });
      recognition.addEventListener("result", (e) => {
        const transcript = e.results[0][0].transcript;
        input.value = transcript;
        input.focus();
      });
      recognition.addEventListener("error", (e) => {
        recognizing = false;
        micBtn.classList.remove("listening");
        if (e.error !== "no-speech" && e.error !== "aborted") {
          console.warn("[rawx-bot-widget] speech recognition error", e.error);
        }
      });
    } else {
      micBtn.style.opacity = "0.4";
    }

    micBtn.addEventListener("click", () => {
      if (!recognition) {
        alert("Voice input isn't supported in this browser — try Chrome on desktop or Android.");
        return;
      }
      if (recognizing) {
        recognition.stop();
        return;
      }
      recognition.lang = currentVoiceLang();
      try {
        recognition.start();
      } catch (err) {
        console.warn("[rawx-bot-widget] could not start recognition", err);
      }
    });

    function setActiveConversation(id) {
      conversationId = id;
      if (id) localStorage.setItem(ACTIVE_CONV_KEY, id);
      else localStorage.removeItem(ACTIVE_CONV_KEY);
    }

    async function saveReaction(messageIndex, emoji) {
      if (!conversationId) return;
      try {
        await fetch(`${ENDPOINT}/api/conversations/${encodeURIComponent(conversationId)}/react`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: SESSION_ID, messageIndex, emoji }),
        });
      } catch (err) {
        console.warn("[rawx-bot-widget] reaction save failed", err);
      }
    }

    function renderHistoryIntoMessages() {
      messagesEl.innerHTML = "";
      history.forEach((m, idx) => {
        addMessage(messagesEl, m.role, m.content, null, null, {
          reaction: m.reaction,
          onReact: m.role === "assistant" ? (emoji) => saveReaction(idx, emoji) : undefined,
        });
      });
    }

    function showAttachError(msg) {
      attachErrorEl.textContent = msg;
      if (msg) setTimeout(() => { if (attachErrorEl.textContent === msg) attachErrorEl.textContent = ""; }, 4000);
    }

    function renderPreview() {
      previewEl.innerHTML = "";
      pendingImages.forEach((img, idx) => {
        const thumb = document.createElement("div");
        thumb.className = "mab-attach-thumb";
        thumb.innerHTML = `<img src="${img.previewUrl}" alt=""><button type="button" aria-label="Remove image">&times;</button>`;
        thumb.querySelector("button").addEventListener("click", () => {
          pendingImages.splice(idx, 1);
          renderPreview();
        });
        previewEl.appendChild(thumb);
      });
    }

    attachBtn.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", async () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = "";
      if (files.length === 0) return;

      for (const file of files) {
        if (pendingImages.length >= MAX_IMAGES) {
          showAttachError(`You can attach up to ${MAX_IMAGES} images.`);
          break;
        }
        if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
          showAttachError("Only JPEG, PNG, WEBP, or GIF images are supported.");
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          showAttachError(`"${file.name}" is over the 4MB limit.`);
          continue;
        }
        try {
          const read = await readImageFile(file);
          pendingImages.push(read);
        } catch (err) {
          console.warn("[rawx-bot-widget]", err);
        }
      }
      renderPreview();
    });

    async function loadConversationList() {
      sidebarListEl.innerHTML = `<div class="mab-sidebar-empty">Loading…</div>`;
      try {
        const res = await fetch(`${ENDPOINT}/api/conversations?sessionId=${encodeURIComponent(SESSION_ID)}`);
        const data = await res.json();
        const list = data.conversations || [];
        if (list.length === 0) {
          sidebarListEl.innerHTML = `<div class="mab-sidebar-empty">No past conversations yet.</div>`;
          return;
        }
        sidebarListEl.innerHTML = "";
        list
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .forEach((c) => {
            const item = document.createElement("div");
            item.className = "mab-sidebar-item";
            item.innerHTML = `<span class="mab-conv-title"></span><span class="mab-conv-time">${formatTime(c.updatedAt)}</span>`;
            item.querySelector(".mab-conv-title").textContent = c.title;
            item.addEventListener("click", () => openConversation(c.id));
            sidebarListEl.appendChild(item);
          });
      } catch (err) {
        sidebarListEl.innerHTML = `<div class="mab-sidebar-empty">Couldn't load history.</div>`;
        console.warn("[rawx-bot-widget]", err);
      }
    }

    async function openConversation(id) {
      try {
        const res = await fetch(`${ENDPOINT}/api/conversations/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(SESSION_ID)}`);
        if (!res.ok) throw new Error("not found");
        const data = await res.json();
        history = data.messages || [];
        setActiveConversation(id);
        renderHistoryIntoMessages();
        setView("chat");
      } catch (err) {
        console.warn("[rawx-bot-widget]", err);
      }
    }

    // Only one of chat / history / search is visible at a time.
    function setView(view) {
      messagesEl.style.display = view === "chat" ? "flex" : "none";
      sidebarEl.style.display = view === "history" ? "flex" : "none";
      searchPanelEl.style.display = view === "search" ? "flex" : "none";
      generatePanelEl.style.display = view === "generate" ? "flex" : "none";
    }

    function startNewConversation() {
      history = [];
      setActiveConversation(null);
      messagesEl.innerHTML = "";
      pendingImages = [];
      renderPreview();
      setView("chat");
      input.focus();
    }

    historyToggle.addEventListener("click", () => {
      const showing = sidebarEl.style.display !== "none";
      if (showing) {
        setView("chat");
      } else {
        setView("history");
        loadConversationList();
      }
    });

    searchToggle.addEventListener("click", () => {
      const showing = searchPanelEl.style.display !== "none";
      if (showing) {
        setView("chat");
      } else {
        setView("search");
        searchInput.focus();
      }
    });

    async function runDriveSearch() {
      const q = searchInput.value.trim();
      if (!q) return;
      searchResultsEl.innerHTML = `<div class="mab-search-empty">Searching…</div>`;
      try {
        const res = await fetch(`${ENDPOINT}/api/drive-search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "search failed");
        const results = data.results || [];
        if (results.length === 0) {
          searchResultsEl.innerHTML = `<div class="mab-search-empty">No matching files found.</div>`;
          return;
        }
        searchResultsEl.innerHTML = "";
        results.forEach((r) => {
          const a = document.createElement("a");
          a.className = "mab-search-item";
          a.href = r.webViewLink || "#";
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          const thumbSrc = r.thumbnailLink || r.iconLink || "";
          a.innerHTML = `
            <div class="mab-search-thumb">${thumbSrc ? `<img src="${thumbSrc}" alt="">` : ""}</div>
            <div class="mab-search-name"></div>
          `;
          a.querySelector(".mab-search-name").textContent = r.name || "Untitled";
          searchResultsEl.appendChild(a);
        });
      } catch (err) {
        searchResultsEl.innerHTML = `<div class="mab-search-empty">Couldn't load results.</div>`;
        console.warn("[rawx-bot-widget]", err);
      }
    }

    searchBtn.addEventListener("click", runDriveSearch);
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runDriveSearch();
    });

    generateToggle.addEventListener("click", () => {
      const showing = generatePanelEl.style.display !== "none";
      setView(showing ? "chat" : "generate");
    });

    genTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        genTabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const tabName = tab.dataset.tab;
        genDocView.style.display = tabName === "document" ? "flex" : "none";
        genImgView.style.display = tabName === "image" ? "flex" : "none";
        genVidView.style.display = tabName === "video" ? "flex" : "none";
        genNegView.style.display = tabName === "negotiate" ? "flex" : "none";
        genCatalogView.style.display = tabName === "catalog" ? "flex" : "none";
        genKbView.style.display = tabName === "kb" ? "flex" : "none";
      });
    });

    genDocBtn.addEventListener("click", async () => {
      const brief = genBrief.value.trim();
      if (!brief) return;
      genDocBtn.disabled = true;
      genDocStatus.textContent = "Generating…";
      genDocOutputWrap.style.display = "none";
      try {
        const res = await fetch(`${ENDPOINT}/api/generate/document`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docType: genDocType.value, brief }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "generation failed");
        genDocOutput.value = data.text || "";
        genDocOutputWrap.style.display = "flex";
        genDocStatus.textContent = "";
      } catch (err) {
        genDocStatus.textContent = "Couldn't generate — try again.";
        console.warn("[rawx-bot-widget]", err);
      } finally {
        genDocBtn.disabled = false;
      }
    });

    genDocCopy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(genDocOutput.value);
        genDocCopy.textContent = "Copied!";
        setTimeout(() => { genDocCopy.textContent = "Copy text"; }, 1500);
      } catch {
        genDocOutput.select();
      }
    });

    genImgBtn.addEventListener("click", async () => {
      const prompt = genImgPrompt.value.trim();
      if (!prompt) return;
      genImgBtn.disabled = true;
      genImgStatus.textContent = "Generating…";
      genImgResult.innerHTML = "";
      try {
        const res = await fetch(`${ENDPOINT}/api/generate/image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "generation failed");
        const { mediaType, data: b64 } = data.image;
        const dataUrl = `data:${mediaType};base64,${b64}`;
        genImgResult.innerHTML = `<img src="${dataUrl}" alt=""><a download="rawx-generated.png" href="${dataUrl}">Download image</a>`;
        genImgStatus.textContent = "";
      } catch (err) {
        genImgStatus.textContent = "Couldn't generate — try again.";
        console.warn("[rawx-bot-widget]", err);
      } finally {
        genImgBtn.disabled = false;
      }
    });

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    genVidBtn.addEventListener("click", async () => {
      const prompt = genVidPrompt.value.trim();
      if (!prompt) return;
      genVidBtn.disabled = true;
      genVidResult.innerHTML = "";
      genVidStatus.textContent = "Submitting…";
      try {
        const demoMode = genVidDemoMode.checked;
        const startRes = await fetch(`${ENDPOINT}/api/generate/${demoMode ? "demo-video" : "video"}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            demoMode
              ? { productBrief: prompt, duration: Number(genVidDuration.value) }
              : { prompt, duration: Number(genVidDuration.value) }
          ),
        });
        const startData = await startRes.json();
        if (!startRes.ok) throw new Error(startData.error || "couldn't start video job");
        const requestId = startData.requestId;

        // Poll every 5s, up to ~2 minutes, since video generation is slow.
        let attempts = 0;
        let done = false;
        while (attempts < 24 && !done) {
          genVidStatus.textContent = `Generating… (${attempts * 5}s)`;
          await sleep(5000);
          const statusRes = await fetch(`${ENDPOINT}/api/generate/video/status?id=${encodeURIComponent(requestId)}`);
          const statusData = await statusRes.json();
          if (!statusRes.ok) throw new Error(statusData.error || "status check failed");
          if (statusData.status === "done" || statusData.status === "completed") {
            const videoUrl = statusData.video?.url || statusData.url;
            if (!videoUrl) throw new Error("Job finished but no video URL was returned");
            genVidResult.innerHTML = `<video controls src="${videoUrl}"></video><a href="${videoUrl}" target="_blank" rel="noopener noreferrer">Open video</a>`;
            genVidStatus.textContent = "";
            done = true;
          } else if (statusData.status === "failed" || statusData.status === "error") {
            throw new Error(statusData.error || "Video generation failed");
          }
          attempts += 1;
        }
        if (!done) genVidStatus.textContent = "Still generating — check back, or try a shorter clip.";
      } catch (err) {
        genVidStatus.textContent = `Couldn't generate: ${err.message}`;
        console.warn("[rawx-bot-widget]", err);
      } finally {
        genVidBtn.disabled = false;
      }
    });

    // ---- Negotiate tab (Phase 3) ----
    let negotiationHistory = [];
    function renderNegLog() {
      genNegLog.innerHTML = "";
      negotiationHistory.forEach((h) => {
        const line = document.createElement("div");
        line.className = `mab-neg-line ${h.role === "buyer" ? "mab-gen-neg-line-buyer" : ""}`;
        line.textContent = `${h.role === "buyer" ? "Buyer" : "You (AI)"}: ${h.text}`;
        genNegLog.appendChild(line);
      });
      genNegLog.scrollTop = genNegLog.scrollHeight;
    }
    genNegBtn.addEventListener("click", async () => {
      const productBrief = genNegBrief.value.trim();
      const buyerMessage = genNegBuyer.value.trim();
      if (!productBrief || !buyerMessage) return;
      genNegBtn.disabled = true;
      genNegStatus.textContent = "Thinking…";
      negotiationHistory.push({ role: "buyer", text: buyerMessage });
      renderNegLog();
      try {
        const res = await fetch(`${ENDPOINT}/api/negotiate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productBrief,
            floorPrice: genNegFloor.value ? Number(genNegFloor.value) : null,
            askPrice: genNegAsk.value ? Number(genNegAsk.value) : null,
            buyerMessage,
            negotiationHistory,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "negotiation failed");
        negotiationHistory.push({ role: "seller", text: data.reply });
        renderNegLog();
        genNegBuyer.value = "";
        genNegStatus.innerHTML = data.suggestedPrice
          ? `<span class="mab-gen-neg-price">Suggested price: ${data.suggestedPrice} — status: ${data.status}</span>`
          : `<span class="mab-gen-neg-price">Status: ${data.status}</span>`;
      } catch (err) {
        genNegStatus.textContent = "Couldn't reach the negotiator — try again.";
        console.warn("[rawx-bot-widget]", err);
      } finally {
        genNegBtn.disabled = false;
      }
    });

    // ---- Catalog tab (Phase 4) ----
    genCatalogBtn.addEventListener("click", async () => {
      const brief = genCatalogBrief.value.trim();
      const languages = Array.from(genCatalogLangs).filter((c) => c.checked).map((c) => c.value);
      if (!brief || languages.length === 0) return;
      genCatalogBtn.disabled = true;
      genCatalogStatus.textContent = "Generating…";
      genCatalogResult.innerHTML = "";
      try {
        const res = await fetch(`${ENDPOINT}/api/generate/catalog`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brief, languages }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "generation failed");
        genCatalogStatus.textContent = "";
        Object.entries(data.languages || {}).forEach(([lang, content]) => {
          const block = document.createElement("div");
          block.className = "mab-gen-catalog-lang";
          const label = { en: "English", bn: "Bengali", jp: "Japanese" }[lang] || lang;
          block.innerHTML = `<h4>${label}</h4><p></p><div class="mab-hashtags"></div>`;
          block.querySelector("p").textContent = content.description || "";
          block.querySelector(".mab-hashtags").textContent = (content.hashtags || []).join(" ");
          genCatalogResult.appendChild(block);
        });
      } catch (err) {
        genCatalogStatus.textContent = "Couldn't generate — try again.";
        console.warn("[rawx-bot-widget]", err);
      } finally {
        genCatalogBtn.disabled = false;
      }
    });

    // ---- Knowledge Base tab (Phase 2 RAG) ----
    genKbBtn.addEventListener("click", async () => {
      const title = genKbTitle.value.trim();
      const text = genKbText.value.trim();
      if (!text) return;
      genKbBtn.disabled = true;
      genKbStatus.textContent = "Indexing…";
      try {
        const res = await fetch(`${ENDPOINT}/api/kb/upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, text }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "upload failed");
        genKbStatus.textContent = `Added ${data.chunksIndexed} chunk(s) to the knowledge base.`;
        genKbTitle.value = "";
        genKbText.value = "";
      } catch (err) {
        genKbStatus.textContent = `Couldn't index: ${err.message}`;
        console.warn("[rawx-bot-widget]", err);
      } finally {
        genKbBtn.disabled = false;
      }
    });

    // ---- Chat themes (Phase 3) ----
    const THEMES = ["dark", "brand", "light"];
    const THEME_KEY = "mab_theme";
    function applyTheme(theme) {
      panel.classList.remove("theme-dark", "theme-brand", "theme-light");
      if (theme !== "dark") panel.classList.add(`theme-${theme}`);
      localStorage.setItem(THEME_KEY, theme);
    }
    applyTheme(localStorage.getItem(THEME_KEY) || "dark");
    themeBtn.addEventListener("click", () => {
      const current = localStorage.getItem(THEME_KEY) || "dark";
      const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
      applyTheme(next);
    });

    // ---- Gamification (Phase 5, lite) ----
    const POINTS_KEY = "mab_points";
    function getPoints() { return Number(localStorage.getItem(POINTS_KEY) || 0); }
    function addPoint() {
      const pts = getPoints() + 1;
      localStorage.setItem(POINTS_KEY, String(pts));
      badgeEl.innerHTML = `&#11088; ${pts}`;
      return pts;
    }
    badgeEl.innerHTML = `&#11088; ${getPoints()}`;

    // ---- Share (Phase 3, lite read-only link) ----
    shareToggle.addEventListener("click", async () => {
      if (!conversationId) {
        alert("Send at least one message first, then share the conversation.");
        return;
      }
      try {
        const res = await fetch(`${ENDPOINT}/api/conversations/${encodeURIComponent(conversationId)}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: SESSION_ID }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "couldn't create share link");
        const shareUrl = `${location.origin}${location.pathname}?share=${data.shareId}`;
        try {
          await navigator.clipboard.writeText(shareUrl);
          alert(`Read-only share link copied to clipboard:\n${shareUrl}`);
        } catch {
          prompt("Copy this read-only share link:", shareUrl);
        }
      } catch (err) {
        alert(`Couldn't create a share link: ${err.message}`);
        console.warn("[rawx-bot-widget]", err);
      }
    });

    // If this page was opened via a share link (?share=ID), render a
    // read-only, auto-polling view of that conversation instead of the
    // normal interactive chat.
    const sharedId = new URLSearchParams(location.search).get("share");
    if (sharedId) {
      form.style.display = "none";
      generateToggle.style.display = "none";
      searchToggle.style.display = "none";
      historyToggle.style.display = "none";
      shareToggle.style.display = "none";
      shareBanner.style.display = "block";
      shareBanner.textContent = "Viewing a shared conversation (read-only) — updates automatically.";
      panel.classList.add("open");
      const pollShared = async () => {
        try {
          const res = await fetch(`${ENDPOINT}/api/shared/${encodeURIComponent(sharedId)}`);
          const data = await res.json();
          if (res.ok) {
            history = data.messages || [];
            renderHistoryIntoMessages();
          }
        } catch (err) {
          console.warn("[rawx-bot-widget] shared poll failed", err);
        }
      };
      pollShared();
      setInterval(pollShared, 5000);
    }

    newChatBtn.addEventListener("click", startNewConversation);
    sidebarNewBtn.addEventListener("click", startNewConversation);

    // Restore the last active conversation on load, if any.
    if (conversationId) {
      openConversation(conversationId);
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;

      if (!conversationId) setActiveConversation(crypto.randomUUID());

      const imagesToSend = pendingImages.map((img) => ({ mediaType: img.mediaType, data: img.data }));
      const imageCount = imagesToSend.length;

      addMessage(messagesEl, "user", text, null, imageCount);
      history.push({ role: "user", content: text });
      input.value = "";
      pendingImages = [];
      renderPreview();

      const provider = providerSelect.value || undefined;

      if (STREAM) {
        await streamReply(provider, imagesToSend);
      } else {
        await plainReply(provider, imagesToSend);
      }
    });

    async function plainReply(provider, images) {
      const thinking = addMessage(messagesEl, "assistant", "...");
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: history,
            images,
            provider,
            system: getPersonalitySystemPrompt(),
            stream: false,
            sessionId: SESSION_ID,
            conversationId,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "request failed");
        thinking.remove();
        const assistantIdx = history.length;
        addMessage(messagesEl, "assistant", data.text, data.providerUsed, null, {
          onReact: (emoji) => saveReaction(assistantIdx, emoji),
        });
        history.push({ role: "assistant", content: data.text });
        addPoint();
        if (autoSpeak) speak(data.text);
      } catch (err) {
        thinking.remove();
        addMessage(messagesEl, "assistant", "Sorry, I couldn't get a response right now.");
        console.warn("[rawx-bot-widget]", err);
      }
    }

    async function streamReply(provider, images) {
      const bubble = addMessage(messagesEl, "assistant", "");
      let fullText = "";
      let providerUsed = null;
      let tagWritten = false;

      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: history,
            images,
            provider,
            system: getPersonalitySystemPrompt(),
            stream: true,
            sessionId: SESSION_ID,
            conversationId,
          }),
        });
        if (!res.ok || !res.body) throw new Error("stream request failed");

        const reader = res.body.getReader();
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
              const evt = JSON.parse(payload);
              if (evt.providerUsed && !providerUsed) providerUsed = evt.providerUsed;
              if (evt.token) {
                fullText += evt.token;
                if (!tagWritten && providerUsed) tagWritten = true;
                bubble.innerHTML = (tagWritten ? `<span class="mab-provider-tag">${providerUsed}</span>` : "") + escapeHtml(fullText);
                messagesEl.scrollTop = messagesEl.scrollHeight;
              }
              if (evt.error) throw new Error(evt.error);
            } catch (parseErr) {
              // ignore partial/malformed lines
            }
          }
        }
        const assistantIdx = history.length;
        history.push({ role: "assistant", content: fullText });
        if (fullText) {
          addSpeakButton(bubble, fullText);
          const meta = document.createElement("div");
          meta.className = "mab-msg-meta";
          const readTime = readingTimeLabel(fullText);
          meta.textContent = readTime ? `${formatTime(Date.now())} · ${readTime}` : formatTime(Date.now());
          bubble.appendChild(meta);
          const row = document.createElement("div");
          row.className = "mab-reactions";
          REACTION_EMOJIS.forEach((emoji) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "mab-react-btn";
            btn.textContent = emoji;
            btn.addEventListener("click", () => {
              const isActive = btn.classList.contains("active");
              row.querySelectorAll(".mab-react-btn").forEach((b) => b.classList.remove("active"));
              if (!isActive) btn.classList.add("active");
              saveReaction(assistantIdx, isActive ? null : emoji);
            });
            row.appendChild(btn);
          });
          bubble.appendChild(row);
          addPoint();
          if (autoSpeak) speak(fullText);
        }
      } catch (err) {
        bubble.textContent = "Sorry, I couldn't get a response right now.";
        console.warn("[rawx-bot-widget]", err);
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
