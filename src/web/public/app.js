/* Native browser UI. Identity is durable; WebSocket connections are disposable. */
(() => {
  const $ = (id) => document.getElementById(id);
  // crypto.randomUUID is unavailable on ordinary HTTP LAN origins.
  const uuid = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  };
  const route = location.hash.match(/^#\/join\/([^?]+)(?:\?(.*))?$/);
  if (!route) { $("status").textContent = "请扫描群组二维码"; $("join-button").disabled = true; return; }
  const groupId = decodeURIComponent(route[1]);
  const inviteCode = new URLSearchParams(route[2] || "").get("invite") || undefined;
  const key = `pi-comms:group:${groupId}`;
  let deviceId, saved;
  try {
    deviceId = localStorage.getItem("pi-comms:device");
    if (!deviceId) { deviceId = uuid(); localStorage.setItem("pi-comms:device", deviceId); }
    saved = JSON.parse(localStorage.getItem(key) || "null");
    if (!saved) { saved = { sessionId: uuid() }; localStorage.setItem(key, JSON.stringify(saved)); }
  } catch { $("error").hidden = false; $("error").textContent = "请允许浏览器保存站点数据，再刷新页面。"; $("join-button").disabled = true; return; }
  let socket, retry, heartbeat, connected = false, stopped = false, joined = false, leaving = false, pendingName;
  const messages = new Map(), members = new Map(), chains = new Map();
  const error = (text) => { $("error").textContent = text; $("error").hidden = !text; };
  const setStatus = (text) => { $("status").textContent = text; $("send-button").disabled = !connected || !joined; $("join-button").disabled = !connected; $("leave-button").disabled = !connected || !joined; };
  const send = (type, payload = {}) => { if (!socket || socket.readyState !== WebSocket.OPEN) return false; socket.send(JSON.stringify({ id: uuid(), type, timestamp: Date.now(), payload })); return true; };
  const join = () => send("group.join", { groupId, ...(saved.membershipCredential ? { membershipCredential: saved.membershipCredential } : { userName: pendingName, ...(inviteCode ? { inviteCode } : {}) }) });
  function renderMembers() {
    $("member-list").replaceChildren();
    for (const member of members.values()) {
      if (member.removed) continue;
      const li = document.createElement("li");
      li.textContent = `${member.displayName}${member.type === "agent" ? " · Agent" : ""}${member.isOwner ? " · 群主" : ""} · ${member.online ? "在线" : "离线"}`;
      $("member-list").append(li);
    }
  }
  function renderMessages() {
    const log = $("messages");
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
    log.replaceChildren();
    for (const message of [...messages.values()].sort((a,b) => a.groupSeq - b.groupSeq).slice(-100)) {
      const article = document.createElement("article"); article.className = "message" + (message.senderName === saved.userName && message.senderType === "user" ? " own" : "");
      const name = document.createElement("strong"); name.textContent = message.senderName + (message.senderType === "agent" ? " · Agent" : "");
      const time = document.createElement("time"); time.textContent = new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const body = document.createElement("p"); body.textContent = message.text;
      article.append(name,time,body);
      if (message.failureReason || message.routeFailureReason) { const state = document.createElement("small"); state.textContent = `投递失败：${message.failureReason || message.routeFailureReason}`; article.append(state); }
      log.append(article);
    }
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }
  function renderChains() {
    $("chains").replaceChildren();
    for (const chain of chains.values()) {
      const article = document.createElement("article"), text = document.createElement("div");
      text.textContent = `Agent 接力已暂停（${chain.roundLimit} 轮）。继续或结束？`;
      article.append(text);
      for (const [label,type] of [["继续","chain.continue"],["结束","chain.end"]]) {
        const button = document.createElement("button"); button.textContent = label; button.disabled = !connected;
        button.onclick = () => send(type,{ chainId: chain.chainId }); article.append(button);
      }
      $("chains").append(article);
    }
  }
  function connect() {
    clearTimeout(retry); if (stopped) return;
    const restoring = joined || Boolean(saved.membershipCredential);
    joined = false; connected = false; setStatus(restoring ? "正在重新连接…" : "连接中…"); renderChains();
    const current = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`); socket = current;
    current.onopen = () => send("web.hello", { deviceId, sessionId: saved.sessionId });
    current.onmessage = (event) => {
      if (socket !== current) return;
      const envelope = JSON.parse(event.data), payload = envelope.payload;
      switch (envelope.type) {
        case "web.welcome":
          if (!connected) { connected = true; setStatus("已连接"); if (saved.membershipCredential || pendingName) join(); }
          clearInterval(heartbeat); heartbeat = setInterval(() => send("ping"), 5000); break;
        case "membership.welcome":
          saved.membershipCredential = payload.membershipCredential; saved.userName = pendingName;
          localStorage.setItem(key, JSON.stringify(saved)); break;
        case "snapshot":
          if (payload.group) {
            joined = true; leaving = false; error("");
            $("group-name").textContent = payload.group.groupName; $("join-view").hidden = true; $("chat-view").hidden = false; $("identity").textContent = saved.userName || "";
            members.clear(); payload.members.forEach((member) => members.set(member.memberId,member));
            messages.clear(); payload.messages.forEach((message) => messages.set(message.messageId,message));
            chains.clear(); (payload.pausedChains || []).forEach((chain) => chains.set(chain.chainId,chain));
            renderMembers(); renderMessages(); renderChains(); setStatus("在线");
          } else if (leaving) {
            leaving = false; joined = false; localStorage.removeItem(key); saved = { sessionId: uuid() }; localStorage.setItem(key,JSON.stringify(saved));
            pendingName = undefined; $("chat-view").hidden = true; $("join-view").hidden = false; $("username").value = ""; $("message").value = "";
            messages.clear(); members.clear(); chains.clear(); socket.close();
          } break;
        case "chat.message": messages.set(envelope.id,{ ...payload, messageId: envelope.id, timestamp: envelope.timestamp }); renderMessages(); break;
        case "presence.changed": members.set(payload.memberId,payload); renderMembers(); break;
        case "presence.removed": payload.memberIds.forEach((id) => members.delete(id)); renderMembers(); break;
        case "chain.paused": chains.set(payload.chainId,payload); renderChains(); break;
        case "chain.resolved": chains.delete(payload.chainId); renderChains(); break;
        case "error":
          error(payload.message); leaving = false;
          if (["session_in_use","member_removed","group_deleted","group_not_found","network_unavailable","invite_invalid","invite_required","invite_rate_limited"].includes(payload.code)) {
            stopped = true; connected = false; setStatus(payload.message); renderChains(); socket.close();
          } else if (payload.code === "membership_invalid") {
            localStorage.removeItem(key); saved = { sessionId: uuid() }; localStorage.setItem(key,JSON.stringify(saved));
            joined = false; pendingName = undefined; $("chat-view").hidden = true; $("join-view").hidden = false; socket.close();
          }
          break;
      }
    };
    current.onclose = () => {
      if (socket !== current) return;
      clearInterval(heartbeat); connected = false; setStatus(stopped ? $("status").textContent : "离线，正在重连…"); renderChains();
      if (!stopped) retry = setTimeout(connect,1500);
    };
    current.onerror = () => { if (!stopped) error("无法连接群聊主机。请确认在同一 Wi-Fi，且群组已开放附近加入。"); };
  }
  $("join-form").onsubmit = (event) => { event.preventDefault(); pendingName = $("username").value.trim(); error(""); join(); };
  $("send-form").onsubmit = (event) => { event.preventDefault(); const text = $("message").value.trim(); if (connected && joined && text && send("chat.send",{ text })) $("message").value = ""; };
  $("leave-button").onclick = () => $("leave-dialog").showModal();
  $("cancel-leave").onclick = () => $("leave-dialog").close();
  $("confirm-leave").onclick = () => { $("leave-dialog").close(); if (connected && joined) leaving = send("group.leave"); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !stopped && socket?.readyState === WebSocket.CLOSED) connect(); });
  window.addEventListener("offline", () => { connected = false; setStatus("离线，等待网络恢复…"); renderChains(); socket?.close(); });
  window.addEventListener("online", () => { if (!stopped) connect(); });
  window.addEventListener("pagehide", () => socket?.close());
  window.addEventListener("pageshow", (event) => { if (event.persisted && !stopped) connect(); });
  fetch(`/api/groups/${encodeURIComponent(groupId)}`).then(async (response) => {
    const data = await response.json(); if (!response.ok) throw new Error(data.error);
    $("group-name").textContent = data.groupName;
  }).catch((cause) => error(cause.message));
  connect();
})();
