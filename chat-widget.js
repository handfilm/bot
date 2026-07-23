/**
 * ==========================================================================
 * Multi-AI Chat Widget — drop-in <script> for any website
 * ==========================================================================
 * Usage:
 *   1. Set window.MULTI_AI_ENDPOINT before loading this file, e.g.:
 *        <script>window.MULTI_AI_ENDPOINT = "https://multi-ai-bot.<sub>.workers.dev";</script>
 *        <script src="chat-widget.js"></script>
 *   2. That's it — a floating chat bubble appears bottom-right on every page
 *      this script is included on.
 *
 * This file holds NO API keys. It only ever talks to your own Worker, which
 * holds the real Anthropic/Gemini/Grok credentials server-side.
 * ==========================================================================
 */
(function () {
  const ENDPOINT = window.MULTI_AI_ENDPOINT || "https://multi-ai-bot.example.workers.dev";
  const STREAM = window.MULTI_AI_STREAM !== false; // default true

  const STYLE = `
  .mab-launcher{
    position:fixed; bottom:24px; right:24px; z-index:9999; width:58px; height:58px; border-radius:50%;
    background:#1a1a1a; border:1px solid #333; color:#fff; cursor:pointer;
    display:flex; align-items:center; justify-content:center; box-shadow:0 6px 20px rgba(0,0,0,.35);
    font-family: system-ui, sans-serif;
  }
  .mab-launcher:hover{ background:#2a2a2a; }
  .mab-panel{
    position:fixed; bottom:92px; right:24px; z-index:9999; width:360px; max-width:calc(100vw - 32px);
    max-height:520px; background:#fff; border:1px solid #ddd; border-radius:12px; overflow:hidden;
    display:none; flex-direction:column; box-shadow:0 16px 48px rgba(0,0,0,.25);
    font-family: system-ui, sans-serif;
  }
  .mab-panel.open{ display:flex; }
  .mab-head{ display:flex; justify-content:space-between; align-items:center; padding:14px 16px; background:#1a1a1a; color:#fff; font-size:0.85rem; }
  .mab-head select{ background:#2a2a2a; color:#fff; border:1px solid #444; font-size:0.72rem; border-radius:6px; padding:4px 6px; }
  .mab-close{ background:none; border:none; color:#bbb; cursor:pointer; font-size:1rem; }
  .mab-messages{ flex:1; overflow-y:auto; padding:14px 16px; display:flex; flex-direction:column; gap:10px; min-height:200px; background:#fafafa; }
  .mab-msg{ font-size:0.88rem; line-height:1.45; padding:9px 13px; border-radius:10px; max-width:85%; white-space:pre-wrap; }
  .mab-msg.user{ align-self:flex-end; background:#1a1a1a; color:#fff; }
  .mab-msg.assistant{ align-self:flex-start; background:#eee; color:#111; }
  .mab-msg.assistant .mab-provider-tag{ display:block; font-size:0.62rem; opacity:0.55; margin-bottom:3px; text-transform:uppercase; letter-spacing:0.05em; }
  .mab-form{ display:flex; border-top:1px solid #eee; }
  .mab-form input{ flex:1; border:none; padding:12px 14px; font-size:0.88rem; outline:none; }
  .mab-form button{ background:#1a1a1a; color:#fff; border:none; padding:0 18px; cursor:pointer; font-size:0.8rem; }
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
        <span>Ask us anything</span>
        <div style="display:flex; gap:8px; align-items:center;">
          <select class="mab-provider">
            <option value="">Auto</option>
            <option value="claude">Claude</option>
            <option value="gemini">Gemini</option>
            <option value="grok">Grok</option>
          </select>
          <button type="button" class="mab-close" aria-label="Close">&times;</button>
        </div>
      </div>
      <div class="mab-messages"></div>
      <form class="mab-form">
        <input type="text" placeholder="Type a message..." required>
        <button type="submit">Send</button>
      </form>
    `;
    document.body.appendChild(panel);

    launcher.addEventListener("click", () => panel.classList.toggle("open"));
    panel.querySelector(".mab-close").addEventListener("click", () => panel.classList.remove("open"));

    return panel;
  }

  function addMessage(container, role, text, providerUsed) {
    const div = document.createElement("div");
    div.className = `mab-msg ${role}`;
    if (role === "assistant" && providerUsed) {
      div.innerHTML = `<span class="mab-provider-tag">${providerUsed}</span>${escapeHtml(text)}`;
    } else {
      div.textContent = text;
    }
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function init() {
    injectStyle();
    const panel = buildUI();
    const messagesEl = panel.querySelector(".mab-messages");
    const form = panel.querySelector(".mab-form");
    const input = form.querySelector("input");
    const providerSelect = panel.querySelector(".mab-provider");

    let history = [];

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      addMessage(messagesEl, "user", text);
      history.push({ role: "user", content: text });
      input.value = "";

      const provider = providerSelect.value || undefined;

      if (STREAM) {
        await streamReply(provider);
      } else {
        await plainReply(provider);
      }
    });

    async function plainReply(provider) {
      const thinking = addMessage(messagesEl, "assistant", "...");
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history, provider, stream: false }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "request failed");
        thinking.remove();
        addMessage(messagesEl, "assistant", data.text, data.providerUsed);
        history.push({ role: "assistant", content: data.text });
      } catch (err) {
        thinking.remove();
        addMessage(messagesEl, "assistant", "Sorry, I couldn't get a response right now.");
        console.warn("[multi-ai-widget]", err);
      }
    }

    async function streamReply(provider) {
      const bubble = addMessage(messagesEl, "assistant", "");
      let fullText = "";
      let providerUsed = null;
      let tagWritten = false;

      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history, provider, stream: true }),
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
                if (!tagWritten && providerUsed) {
                  bubble.innerHTML = `<span class="mab-provider-tag">${providerUsed}</span>`;
                  tagWritten = true;
                }
                bubble.innerHTML = (tagWritten ? `<span class="mab-provider-tag">${providerUsed}</span>` : "") + escapeHtml(fullText);
                messagesEl.scrollTop = messagesEl.scrollHeight;
              }
              if (evt.error) throw new Error(evt.error);
            } catch (parseErr) {
              // ignore partial/malformed lines
            }
          }
        }
        history.push({ role: "assistant", content: fullText });
      } catch (err) {
        bubble.textContent = "Sorry, I couldn't get a response right now.";
        console.warn("[multi-ai-widget]", err);
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
