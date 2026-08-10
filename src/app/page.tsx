"use client";

import {
  ArrowLeft, Bot, ChevronRight, History, LoaderCircle, Mic, MicOff, PanelRight,
  RefreshCw, Send, SlidersHorizontal, Sparkles, Square, Trash2, UserRound,
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
  const recorderRef = useRef<MediaRecorder | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadFrameRef = useRef<number | null>(null);
  const voiceModeRef = useRef(false);
  const audioChunksRef = useRef<Blob[]>([]);
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
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      if (vadFrameRef.current !== null) window.cancelAnimationFrame(vadFrameRef.current);
      void audioContextRef.current?.close();
      microphoneRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state?.messages.length, sending]);

  async function refreshState() {
    setState(await jsonRequest<AppState>("/api/session"));
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
      if (latest && !voiceMuted && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(latest.content);
        utterance.lang = "ja-JP";
        const spoken = new Promise<void>((resolve) => {
          utterance.onend = () => resolve();
          utterance.onerror = () => resolve();
        });
        window.speechSynthesis.speak(utterance);
        await spoken;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "メッセージを送信できませんでした。");
      await refreshState().catch(() => undefined);
    } finally {
      setSending(false);
    }
  }

  function stopVoiceMode() {
    voiceModeRef.current = false;
    setVoiceMode(false);
    window.speechSynthesis?.cancel();
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  }

  async function startVoiceTurn() {
    if (!voiceModeRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia || !("MediaRecorder" in window)) {
      stopVoiceMode();
      setError("このブラウザは音声入力に対応していません。テキスト入力をご利用ください。");
      return;
    }
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      let transcriptionInFlight = false;
      let transcriptionPending = false;
      let finalTranscriptionPending = false;
      let stopped = false;
      let speechDetected = false;
      let lastVoiceAt = performance.now();
      let latestTranscript = "";
      let turnCompleted = false;
      microphoneRef.current = stream;
      recorderRef.current = recorder;
      audioChunksRef.current = [];

      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      audioContextRef.current = audioContext;
      const levels = new Uint8Array(analyser.fftSize);

      function monitorSilence() {
        if (recorder.state !== "recording") return;
        analyser.getByteTimeDomainData(levels);
        let sum = 0;
        for (const level of levels) {
          const normalized = (level - 128) / 128;
          sum += normalized * normalized;
        }
        const volume = Math.sqrt(sum / levels.length);
        const now = performance.now();
        if (volume > 0.025) {
          speechDetected = true;
          lastVoiceAt = now;
        }
        if (speechDetected && now - lastVoiceAt >= 1400) {
          recorder.stop();
          return;
        }
        vadFrameRef.current = window.requestAnimationFrame(monitorSilence);
      }

      async function completeTurn() {
        if (turnCompleted) return;
        turnCompleted = true;
        setInterimText("");
        setTranscribing(false);
        audioChunksRef.current = [];
        const confirmed = latestTranscript.trim();
        if (confirmed) await submitMessage(confirmed);
        if (voiceModeRef.current) await startVoiceTurn();
      }

      async function transcribeLatest(final: boolean) {
        if (transcriptionInFlight) {
          transcriptionPending = true;
          finalTranscriptionPending ||= final;
          return;
        }
        if (audioChunksRef.current.length === 0) return;
        transcriptionInFlight = true;
        setTranscribing(true);
        const audio = new Blob(audioChunksRef.current, { type: recorder.mimeType });
        try {
          const form = new FormData();
          form.append("audio", audio, `recording.${recorder.mimeType.includes("mp4") ? "m4a" : "webm"}`);
          form.append("partial", String(!final));
          const result = await jsonRequest<{ text: string }>("/api/transcribe", { method: "POST", body: form });
          if (result.text) {
            latestTranscript = result.text;
            setMessage(result.text);
            setInterimText(result.text);
          }
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "文字起こしを完了できませんでした。");
        } finally {
          transcriptionInFlight = false;
          if (transcriptionPending) {
            const runFinal = finalTranscriptionPending;
            transcriptionPending = false;
            finalTranscriptionPending = false;
            void transcribeLatest(runFinal);
          } else if (stopped) {
            await completeTurn();
          } else {
            setTranscribing(false);
          }
        }
      }

      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) return;
        audioChunksRef.current.push(event.data);
        if (!stopped && speechDetected) void transcribeLatest(false);
      };
      recorder.onerror = () => {
        stopVoiceMode();
        setError("音声を録音できませんでした。テキスト入力は引き続き利用できます。");
      };
      recorder.onstop = () => {
        stopped = true;
        setRecording(false);
        if (vadFrameRef.current !== null) window.cancelAnimationFrame(vadFrameRef.current);
        vadFrameRef.current = null;
        void audioContext.close();
        audioContextRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        microphoneRef.current = null;
        if (speechDetected) void transcribeLatest(true);
        else void completeTurn();
      };
      recorder.start(1800);
      setRecording(true);
      vadFrameRef.current = window.requestAnimationFrame(monitorSilence);
    } catch {
      stopVoiceMode();
      setError("マイクを利用できません。ブラウザのマイク権限を確認してください。");
    }
  }

  async function toggleRecording() {
    if (voiceModeRef.current) {
      stopVoiceMode();
      return;
    }
    voiceModeRef.current = true;
    setVoiceMode(true);
    await startVoiceTurn();
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
            <button className="icon-button compact" title={voiceMuted ? "読み上げを有効化" : "読み上げをミュート"} onClick={() => { window.speechSynthesis?.cancel(); setVoiceMuted((value) => !value); }}>{voiceMuted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
          </div>

          {state && state.interests.length > 0 && <button className="interest-summary" onClick={() => setProfileOpen(true)}><Sparkles size={15} /><span>{state.interests.slice(0, 3).map((interest) => interest.name).join(" · ")}</span><ChevronRight size={15} /></button>}

          <div className="messages" aria-live="polite">
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

          <form className="composer" onSubmit={(event: FormEvent) => { event.preventDefault(); void submitMessage(); }}>
            {(interimText || voiceMode) && <div className="transcript"><span className="recording-dot" />{interimText || (recording ? "お話しください。無音になると送信します" : sending ? "応答を生成しています…" : "次の発話を準備しています…")}</div>}
            <textarea value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitMessage(); } }} placeholder="例: 家族で使いやすいSUVを見せて" rows={3} disabled={sending} />
            <div className="composer-actions">
              <button type="button" className={`voice-button ${voiceMode ? "recording" : ""}`} onClick={() => void toggleRecording()} title={voiceMode ? "音声入力モードを停止" : "音声入力モードを開始"}>{voiceMode ? <MicOff size={19} /> : transcribing ? <LoaderCircle size={18} className="spin" /> : <Mic size={19} />}</button>
              <span>{voiceMode ? recording ? "発話を待っています" : "応答中。音声モードは継続" : "テキストまたは音声"}</span>
              <button type="submit" className="send-button" disabled={!message.trim() || sending} title="送信">{sending ? <Square size={16} fill="currentColor" /> : <Send size={17} />}</button>
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
