/**
 * ==========================================================================
 * RAWx BOT Chat Widget — Step 1: persistent memory + multiple conversations
 * ==========================================================================
 * Usage (unchanged):
 *   <script>
 *     window.MULTI_AI_ENDPOINT = "https://the-o.himon.workers.dev";
 *     window.MULTI_AI_STREAM = true;
 *   </script>
 *   <script src="chat-widget.js"></script>
 *
 * New in this version:
 *   - A per-browser sessionId is generated and stored in localStorage.
 *   - A history icon opens a sidebar listing past conversations (title +
 *     time), fetched from the Worker's /api/conversations route.
 *   - "New chat" starts a fresh conversation.
 *   - Clicking a past conversation loads its full message history.
 *   - Class names are unprefixed-friendly for brutalist re-theming from the
 *     host page's own injected <style> override, same pattern as before.
 * ==========================================================================
 */
(function () {
  const ENDPOINT = window.MULTI_AI_ENDPOINT || "https://multi-ai-bot.example.workers.dev";
  const STREAM = window.MULTI_AI_STREAM !== false;

  const SESSION_KEY = "mab_session_id";
  const ACTIVE_CONV_KEY = "mab_active_conv_id";

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
  .mab-head{ display:flex; justify-content:space-between; align-items:center; padding:14px 16px; background:#1a1a1a; color:#fff; font-size:0.85rem; gap:8px; }
  .mab-head-actions{ display:flex; gap:8px; align-items:center; }
  .mab-icon-btn{ background:none; border:none; color:#ddd; cursor:pointer; font-size:0.95rem; padding:2px 4px; line-height:1; }
  .mab-icon-btn:hover{ color:#fff; }
  .mab-head select{ background:#2a2a2a; color:#fff; border:1px solid #444; font-size:0.72rem; border-radius:6px; padding:4px 6px; }
  .mab-close{ background:none; border:none; color:#bbb; cursor:pointer; font-size:1rem; }
  .mab-body{ flex:1; display:flex; overflow:hidden; min-height:0; }
  .mab-messages{ flex:1; overflow-y:auto; padding:14px 16px; display:flex; flex-direction:column; gap:10px; min-height:200px; background:#fafafa; }
  .mab-msg{ font-size:0.88rem; line-height:1.45; padding:9px 13px; border-radius:10px; max-width:85%; white-space:pre-wrap; }
  .mab-msg.user{ align-self:flex-end; background:#1a1a1a; color:#fff; }
  .mab-msg.assistant{ align-self:flex-start; background:#eee; color:#111; }
  .mab-msg.assistant .mab-provider-tag{ display:block; font-size:0.62rem; opacity:0.55; margin-bottom:3px; text-transform:uppercase; letter-spacing:0.05em; }
  .mab-form{ display:flex; border-top:1px solid #eee; }
  .mab-form input{ flex:1; border:none; padding:12px 14px; font-size:0.88rem; outline:none; }
  .mab-form button{ background:#1a1a1a; color:#fff; border:none; padding:0 18px; cursor:pointer; font-size:0.8rem; }

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
        <div class="mab-head-actions">
          <button type="button" class="mab-icon-btn mab-history-toggle" aria-label="History" title="History">&#9776;</button>
          <button type="button" class="mab-icon-btn mab-new-chat" aria-label="New chat" title="New chat">+</button>
        </div>
        <span class="mab-head-title">Ask us anything</span>
        <div class="mab-head-actions">
          <select class="mab-provider">
            <option value="">Auto</option>
            <option value="claude">Claude</option>
            <option value="gemini">Gemini</option>
            <option value="grok">Grok</option>
          </select>
          <button type="button" class="mab-close" aria-label="Close">&times;</button>
        </div>
      </div>
      <div class="mab-body">
        <div class="mab-sidebar" style="display:none;">
          <button type="button" class="mab-sidebar-new">+ New conversation</button>
          <div class="mab-sidebar-list"></div>
        </div>
        <div class="mab-messages"></div>
      </div>
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

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  function init() {
    injectStyle();
    const panel = buildUI();
    const messagesEl = panel.querySelector(".mab-messages");
    const sidebarEl = panel.querySelector(".mab-sidebar");
    const sidebarListEl = panel.querySelector(".mab-sidebar-list");
    const historyToggle = panel.querySelector(".mab-history-toggle");
    const newChatBtn = panel.querySelector(".mab-new-chat");
    const sidebarNewBtn = panel.querySelector(".mab-sidebar-new");
    const form = panel.querySelector(".mab-form");
    const input = form.querySelector("input");
    const providerSelect = panel.querySelector(".mab-provider");

    let history = [];
    let conversationId = localStorage.getItem(ACTIVE_CONV_KEY) || null;

    function setActiveConversation(id) {
      conversationId = id;
      if (id) localStorage.setItem(ACTIVE_CONV_KEY, id);
      else localStorage.removeItem(ACTIVE_CONV_KEY);
    }

    function renderHistoryIntoMessages() {
      messagesEl.innerHTML = "";
      history.forEach((m) => addMessage(messagesEl, m.role, m.content));
    }

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
        sidebarEl.style.display = "none";
        messagesEl.style.display = "flex";
      } catch (err) {
        console.warn("[rawx-bot-widget]", err);
      }
    }

    function startNewConversation() {
      history = [];
      setActiveConversation(null);
      messagesEl.innerHTML = "";
      sidebarEl.style.display = "none";
      messagesEl.style.display = "flex";
      input.focus();
    }

    historyToggle.addEventListener("click", () => {
      const showing = sidebarEl.style.display !== "none";
      if (showing) {
        sidebarEl.style.display = "none";
        messagesEl.style.display = "flex";
      } else {
        sidebarEl.style.display = "flex";
        messagesEl.style.display = "none";
        loadConversationList();
      }
    });

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
          body: JSON.stringify({
            messages: history,
            provider,
            stream: false,
            sessionId: SESSION_ID,
            conversationId,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "request failed");
        thinking.remove();
        addMessage(messagesEl, "assistant", data.text, data.providerUsed);
        history.push({ role: "assistant", content: data.text });
      } catch (err) {
        thinking.remove();
        addMessage(messagesEl, "assistant", "Sorry, I couldn't get a response right now.");
        console.warn("[rawx-bot-widget]", err);
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
          body: JSON.stringify({
            messages: history,
            provider,
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
        history.push({ role: "assistant", content: fullText });
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
