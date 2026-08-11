"use client";

import {
  ArrowLeft, Bot, ChevronRight, History, LoaderCircle, Mic, MicOff, PanelRight,
  RefreshCw, Send, ShieldAlert, SlidersHorizontal, Sparkles, Square, Trash2, UserRound,
  Volume2, VolumeX, X,
} from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import type { AppState, BrowserAction, Profile } from "@/lib/domain";

const statusLabels: Record<AppState["browserStatus"], string> = {
  starting: "ブラウザを起動中", ready: "接続済み", user_controlled: "手動操作中",
  agent_running: "AIが操作中", awaiting_approval: "承認待ち", recovering: "再接続中", failed: "接続エラー",
};

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(payload.message ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export default function Home() {
  const [state, setState] = useState<AppState | null>(null);
  const [message, setMessage] = useState("");
  const [interimText, setInterimText] = useState("");
  const [frame, setFrame] = useState(0);
  const [sending, setSending] = useState(false);
  const [browserBusy, setBrowserBusy] = useState(true);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<"web" | "chat">("web");
  const [error, setError] = useState("");
  const microphoneRef = useRef<MediaStream | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const realtimeAudioRef = useRef<HTMLAudioElement | null>(null);
  const speechAudioRef = useRef<HTMLAudioElement | null>(null);
  const speechAbortRef = useRef<AbortController | null>(null);
  const speechUrlRef = useRef<string | null>(null);
  const voiceModeRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    void jsonRequest<AppState>("/api/session", { method: "POST" })
      .then((data) => { if (active) setState(data); })
      .catch((cause: Error) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setBrowserBusy(false); });
    const timer = window.setInterval(() => setFrame((value) => value + 1), 1600);
    return () => {
      active = false;
      window.clearInterval(timer);
      dataChannelRef.current?.close();
      peerConnectionRef.current?.close();
      realtimeAudioRef.current?.pause();
      speechAbortRef.current?.abort();
      speechAudioRef.current?.pause();
      if (speechUrlRef.current) URL.revokeObjectURL(speechUrlRef.current);
      microphoneRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state?.messages.length, sending]);

  async function refreshState() {
    setState(await jsonRequest<AppState>("/api/session"));
  }

  function stopSpeech() {
    speechAbortRef.current?.abort();
    speechAbortRef.current = null;
    const audio = speechAudioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    speechAudioRef.current = null;
    if (speechUrlRef.current) URL.revokeObjectURL(speechUrlRef.current);
    speechUrlRef.current = null;
  }

  async function playSpeech(text: string) {
    stopSpeech();
    const controller = new AbortController();
    speechAbortRef.current = controller;
    const response = await fetch("/api/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("音声を生成できませんでした。");
    const url = URL.createObjectURL(await response.blob());
    speechUrlRef.current = url;
    const audio = new Audio(url);
    speechAudioRef.current = audio;
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onpause = () => resolve();
      audio.onerror = () => reject(new Error("音声を再生できませんでした。"));
      void audio.play().catch(reject);
    });
    stopSpeech();
  }

  async function browserAction(action: Omit<BrowserAction, "actor">) {
    setBrowserBusy(true);
    setError("");
    try {
      await jsonRequest("/api/browser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...action, actor: "user", operationId: crypto.randomUUID() }),
      });
      setFrame((value) => value + 1);
      await refreshState();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ブラウザを操作できませんでした。");
    } finally {
      setBrowserBusy(false);
    }
  }

  function handleBrowserClick(event: React.MouseEvent<HTMLImageElement>) {
    if (browserBusy || state?.browserStatus === "agent_running") return;
    const rect = event.currentTarget.getBoundingClientRect();
    void browserAction({
      type: "click",
      x: ((event.clientX - rect.left) / rect.width) * 1440,
      y: ((event.clientY - rect.top) / rect.height) * 900,
    });
  }

  async function submitMessage(text = message) {
    const value = text.trim();
    if (!value || sending) return;
    setMessage("");
    setInterimText("");
    setSending(true);
    setError("");
    try {
      const next = await jsonRequest<AppState>("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: value }),
      });
      setState(next);
      setFrame((current) => current + 1);
      const latest = [...next.messages].reverse().find((item) => item.role === "assistant");
      if (latest && !voiceMuted) {
        await playSpeech(latest.content).catch((cause) => {
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          setError(cause instanceof Error ? cause.message : "音声を再生できませんでした。");
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "メッセージを送信できませんでした。");
      await refreshState().catch(() => undefined);
    } finally {
      setSending(false);
    }
  }

  async function clearChat() {
    setError("");
    stopSpeech();
    try {
      setState(await jsonRequest<AppState>("/api/chat", { method: "DELETE" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "チャットをクリアできませんでした。");
    }
  }

  function stopVoiceMode() {
    voiceModeRef.current = false;
    setVoiceMode(false);
    setRecording(false);
    setSending(false);
    setTranscribing(false);
    setInterimText("");
    stopSpeech();
    dataChannelRef.current?.close();
    dataChannelRef.current = null;
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    realtimeAudioRef.current?.pause();
    realtimeAudioRef.current = null;
    microphoneRef.current?.getTracks().forEach((track) => track.stop());
    microphoneRef.current = null;
  }

  async function persistRealtimeMessage(role: "user" | "assistant", content: string) {
    const result = await jsonRequest<{
      state: AppState;
      browserTask: { ok: boolean; currentUrl: string; message: string } | null;
    }>("/api/realtime/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, content }),
    });
    setState(result.state);
    if (result.browserTask) setFrame((value) => value + 1);
    return result.browserTask;
  }

  async function completeRealtimeUserTurn(transcript: string) {
    setState((current) => current ? {
      ...current,
      messages: [...current.messages, {
        id: crypto.randomUUID(),
        role: "user",
        content: transcript,
        createdAt: new Date().toISOString(),
      }],
    } : current);
    try {
      const browserTask = await persistRealtimeMessage("user", transcript);
      setSending(true);
      const instructions = browserTask
        ? `サーバーでブラウザ操作が完了しました。現在URLは ${browserTask.currentUrl} です。toolを再度呼び出さず、${browserTask.message}と簡潔に日本語で伝えてください。読み込み中とは言わないでください。`
        : undefined;
      dataChannelRef.current?.send(JSON.stringify({
        type: "response.create",
        ...(instructions ? { response: { instructions } } : {}),
      }));
    } catch (cause) {
      setSending(false);
      setError(cause instanceof Error ? cause.message : "音声の要求を処理できませんでした。");
    }
  }

  async function handleRealtimeTool(event: { name?: string; call_id?: string; arguments?: string }) {
    if (!event.name || !event.call_id) return;
    setSending(true);
    try {
      const args = JSON.parse(event.arguments ?? "{}") as object;
      const result = await jsonRequest<object>("/api/realtime/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: event.name, arguments: args }),
      });
      dataChannelRef.current?.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: event.call_id, output: JSON.stringify(result) },
      }));
      dataChannelRef.current?.send(JSON.stringify({ type: "response.create" }));
      if (event.name === "request_browser_task") {
        setFrame((value) => value + 1);
        await refreshState();
      }
    } catch (cause) {
      const output = { ok: false, message: cause instanceof Error ? cause.message : "処理を完了できませんでした。" };
      dataChannelRef.current?.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: event.call_id, output: JSON.stringify(output) },
      }));
      dataChannelRef.current?.send(JSON.stringify({ type: "response.create" }));
    }
  }

  function handleRealtimeEvent(raw: string) {
    let event: {
      type?: string; transcript?: string; delta?: string; name?: string; call_id?: string; arguments?: string;
      error?: { message?: string };
    };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      return;
    }
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        setRecording(true);
        setSending(false);
        setInterimText("お話しください…");
        break;
      case "input_audio_buffer.speech_stopped":
        setRecording(false);
        setSending(false);
        setInterimText("認識しています…");
        break;
      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) setInterimText(event.delta);
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript?.trim()) {
          setInterimText(event.transcript.trim());
          void completeRealtimeUserTurn(event.transcript.trim());
        }
        break;
      case "response.output_audio_transcript.delta":
        if (event.delta) setInterimText(event.delta);
        break;
      case "response.output_audio_transcript.done":
        if (event.transcript?.trim()) {
          setInterimText("");
          void persistRealtimeMessage("assistant", event.transcript.trim()).catch(() => undefined);
        }
        break;
      case "response.function_call_arguments.done":
        void handleRealtimeTool(event);
        break;
      case "response.done":
        setSending(false);
        break;
      case "error":
        setSending(false);
        setError(event.error?.message ?? "音声セッションでエラーが発生しました。");
        break;
    }
  }

  async function startVoiceMode() {
    if (!navigator.mediaDevices?.getUserMedia || !("RTCPeerConnection" in window)) {
      stopVoiceMode();
      setError("このブラウザは音声入力に対応していません。テキスト入力をご利用ください。");
      return;
    }
    setError("");
    setTranscribing(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphoneRef.current = stream;
      const session = await jsonRequest<{ clientSecret: string; callsUrl: string }>("/api/realtime/session", { method: "POST" });
      const peer = new RTCPeerConnection();
      peerConnectionRef.current = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      const audio = new Audio();
      audio.autoplay = true;
      audio.muted = voiceMuted;
      peer.ontrack = (event) => { audio.srcObject = event.streams[0]; };
      realtimeAudioRef.current = audio;
      const channel = peer.createDataChannel("oai-events");
      dataChannelRef.current = channel;
      channel.onmessage = (event) => handleRealtimeEvent(String(event.data));
      channel.onclose = () => { if (voiceModeRef.current) stopVoiceMode(); };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const answer = await fetch(session.callsUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.clientSecret}`, "Content-Type": "application/sdp" },
        body: offer.sdp,
      });
      if (!answer.ok) throw new Error(`Realtime connection failed: ${answer.status}`);
      await peer.setRemoteDescription({ type: "answer", sdp: await answer.text() });
      setTranscribing(false);
      setRecording(true);
    } catch (cause) {
      stopVoiceMode();
      setError(cause instanceof Error ? cause.message : "マイクを利用できません。ブラウザのマイク権限を確認してください。");
    }
  }

  async function toggleRecording() {
    if (voiceModeRef.current) {
      stopVoiceMode();
      return;
    }
    voiceModeRef.current = true;
    setVoiceMode(true);
    await startVoiceMode();
  }

  async function stopAgent() {
    dataChannelRef.current?.send(JSON.stringify({ type: "response.cancel" }));
    setSending(false);
    setBrowserBusy(false);
    try {
      setState(await jsonRequest<AppState>("/api/realtime/tool", { method: "DELETE" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "処理を停止できませんでした。");
    }
  }

  async function decideApproval(decision: "approve" | "reject") {
    const approval = state?.approval;
    if (!approval) return;
    setSending(true);
    setBrowserBusy(decision === "approve");
    setError("");
    try {
      const response = await jsonRequest<{ state: AppState }>("/api/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: approval.id, decision }),
      });
      setState(response.state);
      setFrame((value) => value + 1);
      if (dataChannelRef.current?.readyState === "open") {
        dataChannelRef.current.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text: decision === "approve" ? "画面で操作を承認しました。結果を説明してください。" : "画面で操作を拒否しました。別の方法を提案してください。" }] },
        }));
        dataChannelRef.current.send(JSON.stringify({ type: "response.create" }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "承認を処理できませんでした。");
      await refreshState().catch(() => undefined);
    } finally {
      setSending(false);
      setBrowserBusy(false);
    }
  }

  async function updateProfile(update: Partial<Profile>) {
    setState(await jsonRequest<AppState>("/api/profile", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update),
    }));
  }

  async function profileOperation(payload: object) {
    setState(await jsonRequest<AppState>("/api/profile", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }));
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">WVA</div>
          <div><h1>Webpage Vision Agent</h1><p>Lexus concierge workspace</p></div>
        </div>
        <div className="topbar-actions">
          <span className={`mode-chip ${state?.agentMode === "foundry" ? "is-live" : ""}`}>
            <Sparkles size={14} /> {state?.agentMode === "foundry" ? "Foundry" : "Demo mode"}
          </span>
          <button className="icon-button" title="プロファイル" onClick={() => setProfileOpen(true)}><UserRound size={19} /></button>
        </div>
      </header>

      <nav className="mobile-tabs" aria-label="表示ペイン">
        <button className={mobilePane === "web" ? "active" : ""} onClick={() => setMobilePane("web")}>Web</button>
        <button className={mobilePane === "chat" ? "active" : ""} onClick={() => setMobilePane("chat")}>チャット</button>
      </nav>

      <section className="workspace">
        <section className={`browser-pane ${mobilePane === "web" ? "mobile-active" : ""}`} aria-label="Lexus Webブラウザ">
          <div className="browser-toolbar">
            <div className="browser-controls">
              <button className="icon-button compact" title="戻る" onClick={() => void browserAction({ type: "back" })}><ArrowLeft size={17} /></button>
              <button className="icon-button compact" title="再読み込み" onClick={() => void browserAction({ type: "reload" })}><RefreshCw size={16} /></button>
            </div>
            <div className="address-bar" title={state?.currentUrl}><span className="secure-dot" /><span>{state?.currentUrl ?? "https://lexus.jp/"}</span></div>
            <div className="browser-status"><span className={`status-light status-${state?.browserStatus ?? "starting"}`} />{state ? statusLabels[state.browserStatus] : "接続中"}</div>
          </div>

          <div className="browser-stage">
            {(browserBusy || !state) && <div className="browser-loader"><LoaderCircle size={26} className="spin" /><span>{state?.browserStatus === "agent_running" ? "AIがページを操作しています" : "ブラウザを同期しています"}</span></div>}
            {state?.browserStatus !== "failed" && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/browser?frame=${frame}`} alt="Lexus公式サイトのライブブラウザ画面" draggable={false} onClick={handleBrowserClick} onLoad={() => setBrowserBusy(false)} onError={() => setBrowserBusy(false)} />
            )}
            {state?.browserStatus === "failed" && <div className="browser-empty"><PanelRight size={28} /><strong>ブラウザを開始できませんでした</strong><button onClick={() => window.location.reload()}>再試行</button></div>}
          </div>

          <div className="browser-footer"><span>1440 × 900 secure session</span><div><button title="上へスクロール" onClick={() => void browserAction({ type: "scroll", deltaY: -620 })}>↑</button><button title="下へスクロール" onClick={() => void browserAction({ type: "scroll", deltaY: 620 })}>↓</button></div></div>
        </section>

        <aside className={`chat-pane ${mobilePane === "chat" ? "mobile-active" : ""}`} aria-label="AIアシスタント">
          <div className="chat-heading">
            <div><span className="eyebrow">AI CONCIERGE</span><h2>ご希望を伺います</h2></div>
            <div className="chat-heading-actions">
              <button className="icon-button compact" title="チャットをクリア" aria-label="チャットをクリア" disabled={sending || !state?.messages.length} onClick={() => void clearChat()}><Trash2 size={17} /></button>
              <button className="icon-button compact" title={voiceMuted ? "読み上げを有効化" : "読み上げをミュート"} onClick={() => { stopSpeech(); setVoiceMuted((value) => { const next = !value; if (realtimeAudioRef.current) realtimeAudioRef.current.muted = next; return next; }); }}>{voiceMuted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
            </div>
          </div>

          {state && state.interests.length > 0 && <button className="interest-summary" onClick={() => setProfileOpen(true)}><Sparkles size={15} /><span>{state.interests.slice(0, 3).map((interest) => interest.name).join(" · ")}</span><ChevronRight size={15} /></button>}

          <div className="messages" aria-live="polite">
            {state?.messages.length === 0 && <p className="chat-empty">新しいメッセージを入力して会話を始められます。</p>}
            {state?.messages.map((item) => (
              <article className={`message message-${item.role}`} key={item.id}>
                <div className="message-avatar">{item.role === "assistant" ? <Bot size={16} /> : item.role === "user" ? <UserRound size={16} /> : <Sparkles size={16} />}</div>
                <div><span>{item.role === "assistant" ? "Concierge" : item.role === "user" ? "You" : "System"}</span><p>{item.content}</p></div>
              </article>
            ))}
            {sending && <article className="message message-assistant"><div className="message-avatar"><Bot size={16} /></div><div><span>Concierge</span><p className="thinking"><i /><i /><i /></p></div></article>}
            <div ref={messagesEndRef} />
          </div>

          {error && <div className="error-banner" role="alert">{error}<button title="閉じる" onClick={() => setError("")}><X size={14} /></button></div>}

          {state?.approval && <section className="approval-banner" aria-label="重要操作の承認">
            <div className="approval-heading"><ShieldAlert size={18} /><strong>操作の確認が必要です</strong></div>
            <dl><div><dt>操作</dt><dd>{state.approval.operation}</dd></div><div><dt>対象</dt><dd>{state.approval.targetUrl}</dd></div><div><dt>影響</dt><dd>{state.approval.impact}</dd></div></dl>
            <div className="approval-actions"><button type="button" onClick={() => void decideApproval("reject")} disabled={sending}>拒否</button><button type="button" className="approve-button" onClick={() => void decideApproval("approve")} disabled={sending}>この1回だけ承認</button></div>
          </section>}

          <form className="composer" onSubmit={(event: FormEvent) => { event.preventDefault(); void submitMessage(); }}>
            {(interimText || voiceMode) && <div className="transcript"><span className="recording-dot" />{interimText || (transcribing ? "音声セッションに接続しています…" : recording ? "お話しください" : sending ? "応答を生成しています…" : "次の発話を待っています…")}</div>}
            <textarea value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitMessage(); } }} placeholder="例: 家族で使いやすいSUVを見せて" rows={3} disabled={sending} />
            <div className="composer-actions">
              <button type="button" className={`voice-button ${voiceMode ? "recording" : ""}`} onClick={() => void toggleRecording()} title={voiceMode ? "音声入力モードを停止" : "音声入力モードを開始"}>{voiceMode ? <MicOff size={19} /> : transcribing ? <LoaderCircle size={18} className="spin" /> : <Mic size={19} />}</button>
              <span>{voiceMode ? transcribing ? "接続中" : recording ? "リアルタイム音声" : "応答中。音声モードは継続" : "テキストまたは音声"}</span>
              <button type={sending ? "button" : "submit"} className="send-button" disabled={!sending && !message.trim()} title={sending ? "生成と操作を停止" : "送信"} onClick={sending ? () => void stopAgent() : undefined}>{sending ? <Square size={16} fill="currentColor" /> : <Send size={17} />}</button>
            </div>
          </form>
        </aside>
      </section>

      {profileOpen && state && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setProfileOpen(false)}>
          <section className="profile-panel" role="dialog" aria-modal="true" aria-label="プロファイル" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><span className="eyebrow">PERSONALIZATION</span><h2>プロファイル</h2></div><button className="icon-button" title="閉じる" onClick={() => setProfileOpen(false)}><X size={19} /></button></header>
            <div className="profile-content">
              <section className="profile-section">
                <div className="section-title"><SlidersHorizontal size={17} /><h3>希望条件</h3></div>
                <div className="form-grid">
                  <label>表示名<input defaultValue={state.profile.displayName} onBlur={(event) => void updateProfile({ displayName: event.target.value })} /></label>
                  <label>居住地域<input defaultValue={state.profile.region} onBlur={(event) => void updateProfile({ region: event.target.value })} /></label>
                  <label>予算<input defaultValue={state.profile.budget} onBlur={(event) => void updateProfile({ budget: event.target.value })} /></label>
                  <label>乗車人数<input type="number" min="1" max="20" defaultValue={state.profile.passengers} onBlur={(event) => void updateProfile({ passengers: Number(event.target.value) })} /></label>
                  <label className="span-two">主な用途<input defaultValue={state.profile.usage} onBlur={(event) => void updateProfile({ usage: event.target.value })} /></label>
                  <label className="span-two">重視すること<input defaultValue={state.profile.priorities} onBlur={(event) => void updateProfile({ priorities: event.target.value })} /></label>
                </div>
              </section>

              <section className="profile-section">
                <div className="section-title"><Sparkles size={17} /><h3>閲覧から見つけた興味</h3><span>{state.interests.length}</span></div>
                <div className="interest-list">
                  {state.interests.length === 0 && <p className="empty-copy">ページを見ると、車種や機能への興味がここに追加されます。</p>}
                  {state.interests.map((interest) => <div className="interest-row" key={interest.id}><div><strong>{interest.name}</strong><span>{interest.category} · 根拠 {interest.evidenceIds.length}件</span></div><div className="score"><i style={{ width: `${interest.score * 100}%` }} /></div><button title={`${interest.name}を削除`} onClick={() => void profileOperation({ operation: "delete_interest", id: interest.id })}><Trash2 size={15} /></button></div>)}
                </div>
              </section>

              <section className="profile-section">
                <div className="section-title"><History size={17} /><h3>行動履歴</h3><span>{state.activity.length}</span></div>
                <label className="collection-toggle"><input type="checkbox" checked={state.profile.activityCollection} onChange={(event) => void updateProfile({ activityCollection: event.target.checked })} /><span><strong>閲覧履歴をプロファイルに反映</strong><small>ページとリンクの履歴から興味を自動更新します</small></span></label>
                <div className="activity-list">{state.activity.slice(0, 8).map((activity) => <div key={activity.id}><span>{activity.type === "page_viewed" ? "閲覧" : "クリック"} · {activity.actor === "agent" ? "AI" : "手動"}</span><strong>{activity.title || activity.url}</strong></div>)}</div>
                {state.activity.length > 0 && <button className="danger-button" onClick={() => void profileOperation({ operation: "clear_activity" })}><Trash2 size={15} />履歴と興味を削除</button>}
              </section>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
