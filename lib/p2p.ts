// =====================================================================
// WebRTC connection helpers for the P2P quiz app.
//
// Design notes:
//  - One data channel per connection, negotiated symmetrically on both
//    sides (`negotiated: true, id: 0`) so no `ondatachannel` is needed.
//  - All reliability concerns (ACKs, retry with exponential backoff,
//    dedup of incoming messages) are handled by `ReliableMessenger`.
//    Consumers register listeners via `onMessage`/`onChannelStateChange`/
//    `onConnectionStateChange` instead of assigning `channel.onmessage`
//    (which is a single-slot and would clobber the library handlers).
//  - Signaling is polled via relative URLs; the creator can trigger an
//    ICE restart by publishing a new offer and the participant watches
//    for offer changes and re-negotiates automatically.
// =====================================================================

// ---------- Configuration ----------

const ICE_CONFIGURATION: RTCConfiguration = {
  iceServers: [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
      ],
    },
    {
      urls: [
        'turn:us-turn1.3cx.com:443?transport=tcp',
        'turn:us-turn2.3cx.com:80?transport=tcp',
      ],
      username: 'test',
      credential: 'test',
    },
  ],
  iceTransportPolicy: 'all',
  iceCandidatePoolSize: 4,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

const DATA_CHANNEL_INIT: RTCDataChannelInit = {
  ordered: true,
  negotiated: true,
  id: 0,
  protocol: 'quiz',
};

const SIGNAL_ENDPOINT = '/api/signal';

// Reliability / polling tuning
const ACK_INITIAL_TIMEOUT_MS = 1500;
const ACK_MAX_TIMEOUT_MS = 8000;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEDUP_TTL_MS = 5 * 60 * 1000;
const SIGNAL_POLL_ACTIVE_MS = 1500;
const SIGNAL_POLL_IDLE_MS = 5000;
const RECOVERY_DEBOUNCE_MS = 2000;

// ---------- Public types ----------

export type P2PMessage = { [key: string]: unknown };
export type MessageHandler = (data: P2PMessage) => void;
export type ChannelStateHandler = (state: RTCDataChannelState) => void;
export type ConnectionStateHandler = (state: RTCPeerConnectionState) => void;
export type Unsubscribe = () => void;

export interface P2PConnection {
  peer: RTCPeerConnection;
  sessionId: string;
  /** Send a message with delivery guarantees (retried until ACK or max attempts). Returns the messageId. */
  sendReliable: (data: P2PMessage) => string | null;
  /** Fire-and-forget send. Returns true if the message was handed to the channel. */
  sendUnreliable: (data: P2PMessage) => boolean;
  onMessage: (handler: MessageHandler) => Unsubscribe;
  onChannelStateChange: (handler: ChannelStateHandler) => Unsubscribe;
  onConnectionStateChange: (handler: ConnectionStateHandler) => Unsubscribe;
  getChannelState: () => RTCDataChannelState;
  getConnectionState: () => RTCPeerConnectionState;
  /** Tear everything down: stop polling, close queue, close channel and peer. */
  close: () => void;
}

// ---------- Utilities ----------

function generateId(): string {
  const buf = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function iceKey(ice: RTCIceCandidateInit): string {
  // Stable string representation for dedup across polls.
  return JSON.stringify({
    c: ice.candidate,
    m: ice.sdpMid,
    i: ice.sdpMLineIndex,
    u: ice.usernameFragment,
  });
}

async function postJson(body: unknown): Promise<Response> {
  return fetch(SIGNAL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function putJson(body: unknown): Promise<Response> {
  return fetch(SIGNAL_ENDPOINT, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------- Reliable messenger ----------

interface PendingMessage {
  messageId: string;
  serialized: string;
  attempts: number;
  maxAttempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

class ReliableMessenger {
  private readonly channel: RTCDataChannel;
  private readonly logPrefix: string;
  private readonly pending = new Map<string, PendingMessage>();
  private readonly seenIncoming = new Map<string, number>();
  private readonly seenAcked = new Map<string, number>();
  private readonly messageHandlers = new Set<MessageHandler>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(channel: RTCDataChannel, logPrefix: string) {
    this.channel = channel;
    this.logPrefix = logPrefix;

    // addEventListener (not onmessage=) so app-level listeners can coexist.
    this.channel.addEventListener('message', this.handleIncoming);
    this.channel.addEventListener('open', this.flushPending);

    this.cleanupInterval = setInterval(this.pruneDedupMaps, DEDUP_TTL_MS);
  }

  addMessageHandler(handler: MessageHandler): Unsubscribe {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  sendReliable(data: P2PMessage, maxAttempts = DEFAULT_MAX_ATTEMPTS): string | null {
    if (this.closed) return null;

    const existingId = typeof data.messageId === 'string' ? data.messageId : '';
    const messageId = existingId.length > 0 ? existingId : generateId();

    if (this.seenAcked.has(messageId)) return messageId; // already delivered
    if (this.pending.has(messageId)) return messageId; // already enqueued

    const enveloped: P2PMessage = { ...data, messageId };
    const serialized = JSON.stringify(enveloped);

    const message: PendingMessage = {
      messageId,
      serialized,
      attempts: 0,
      maxAttempts,
      timer: null,
    };

    this.pending.set(messageId, message);
    this.trySend(message);
    return messageId;
  }

  sendUnreliable(data: P2PMessage): boolean {
    if (this.closed || this.channel.readyState !== 'open') return false;
    try {
      this.channel.send(JSON.stringify(data));
      return true;
    } catch (err) {
      console.error(`${this.logPrefix}[ReliableMessenger] send failed:`, err);
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.removeEventListener('message', this.handleIncoming);
    this.channel.removeEventListener('open', this.flushPending);
    for (const msg of this.pending.values()) {
      if (msg.timer) clearTimeout(msg.timer);
    }
    this.pending.clear();
    this.messageHandlers.clear();
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  // ----- internals -----

  private pruneDedupMaps = () => {
    const now = Date.now();
    for (const [id, ts] of this.seenIncoming) {
      if (now - ts > DEDUP_TTL_MS) this.seenIncoming.delete(id);
    }
    for (const [id, ts] of this.seenAcked) {
      if (now - ts > DEDUP_TTL_MS) this.seenAcked.delete(id);
    }
  };

  private flushPending = () => {
    if (this.closed) return;
    for (const msg of this.pending.values()) {
      if (msg.timer === null) this.trySend(msg);
    }
  };

  private handleIncoming = (event: MessageEvent) => {
    if (this.closed) return;

    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(event.data);
    } catch {
      return; // malformed / not our format
    }
    if (!parsedUnknown || typeof parsedUnknown !== 'object' || Array.isArray(parsedUnknown)) {
      return;
    }
    const parsed = parsedUnknown as P2PMessage;

    // ACK handling: mark pending outgoing as delivered.
    if (parsed.type === 'ack' && typeof parsed.messageId === 'string') {
      this.handleAck(parsed.messageId);
      return;
    }

    // Any message that carries a `messageId` was sent through `sendReliable`
    // on the peer; acknowledge it every time we see it (so retries by the
    // peer due to lost ACKs resolve) and deduplicate delivery to handlers.
    const mid = parsed.messageId;
    if (typeof mid === 'string' && mid.length > 0) {
      this.sendAck(mid);
      if (this.seenIncoming.has(mid)) return;
      this.seenIncoming.set(mid, Date.now());
    }

    for (const h of this.messageHandlers) {
      try {
        h(parsed);
      } catch (err) {
        console.error(`${this.logPrefix}[ReliableMessenger] handler threw:`, err);
      }
    }
  };

  private sendAck(messageId: string) {
    if (this.channel.readyState !== 'open') return;
    try {
      this.channel.send(JSON.stringify({ type: 'ack', messageId }));
    } catch (err) {
      console.error(`${this.logPrefix}[ReliableMessenger] failed to send ack:`, err);
    }
  }

  private handleAck(messageId: string) {
    const msg = this.pending.get(messageId);
    if (!msg) return;
    if (msg.timer) clearTimeout(msg.timer);
    this.pending.delete(messageId);
    this.seenAcked.set(messageId, Date.now());
  }

  private trySend(message: PendingMessage) {
    if (this.closed) return;
    if (!this.pending.has(message.messageId)) return;

    if (message.attempts >= message.maxAttempts) {
      console.warn(
        `${this.logPrefix}[ReliableMessenger] dropping message after ${message.attempts} attempts`,
        message.messageId
      );
      this.pending.delete(message.messageId);
      return;
    }

    if (this.channel.readyState !== 'open') {
      // Don't burn attempts while disconnected; we'll retry on 'open'.
      return;
    }

    message.attempts += 1;
    try {
      this.channel.send(message.serialized);
    } catch (err) {
      console.error(`${this.logPrefix}[ReliableMessenger] send threw:`, err);
    }

    const backoff = Math.min(
      ACK_INITIAL_TIMEOUT_MS * Math.pow(2, message.attempts - 1),
      ACK_MAX_TIMEOUT_MS
    );
    message.timer = setTimeout(() => {
      message.timer = null;
      if (this.pending.has(message.messageId)) this.trySend(message);
    }, backoff);
  }
}

// ---------- Signaling polling ----------

interface SessionInfo {
  offer?: RTCSessionDescriptionInit;
  creatorIce?: RTCIceCandidateInit[];
  participants?: Record<
    string,
    {
      answer?: RTCSessionDescriptionInit;
      participantIce?: RTCIceCandidateInit[];
      lastSeen?: number;
    }
  >;
}

async function fetchSession(sessionId: string, participantId?: string): Promise<SessionInfo> {
  const url = new URL(SIGNAL_ENDPOINT, window.location.origin);
  url.searchParams.set('session', sessionId);
  if (participantId) url.searchParams.set('participant', participantId);
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`Signaling GET failed: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

/** Schedules a polling loop with self-adjusting interval. Returns a cancel function. */
function startPollingLoop(poll: () => Promise<void>, getInterval: () => number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(run, delay);
  };
  const run = async () => {
    timer = null;
    if (stopped) return;
    try {
      await poll();
    } catch (err) {
      console.warn('[poll] error:', err);
    } finally {
      schedule(getInterval());
    }
  };

  schedule(0);
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

// ---------- Creator ----------

export async function createConnection(): Promise<P2PConnection> {
  const peer = new RTCPeerConnection(ICE_CONFIGURATION);
  console.log('[Creator] Creating RTCPeerConnection');

  const channel = peer.createDataChannel('quizChannel', DATA_CHANNEL_INIT);
  console.log('[Creator] Data channel created with id', channel.id);

  const messenger = new ReliableMessenger(channel, '[Creator]');
  const channelHandlers = new Set<ChannelStateHandler>();
  const connHandlers = new Set<ConnectionStateHandler>();

  const notifyChannel = () => channelHandlers.forEach((h) => h(channel.readyState));
  const notifyConn = () => connHandlers.forEach((h) => h(peer.connectionState));

  channel.addEventListener('open', notifyChannel);
  channel.addEventListener('close', notifyChannel);
  channel.addEventListener('error', notifyChannel);
  peer.addEventListener('connectionstatechange', notifyConn);

  // Buffer ICE candidates that arrive before the session is registered.
  const earlyIce: RTCIceCandidateInit[] = [];
  let sessionId: string | null = null;
  const sendIce = async (ice: RTCIceCandidateInit) => {
    try {
      const r = await putJson({ sessionId, role: 'creator', ice });
      if (!r.ok) console.error('[Creator] ICE PUT rejected:', r.status);
    } catch (err) {
      console.error('[Creator] Failed to send ICE:', err);
    }
  };
  peer.onicecandidate = (event) => {
    if (!event.candidate) {
      console.log('[Creator] ICE gathering complete');
      return;
    }
    const ice = event.candidate.toJSON();
    if (!sessionId) {
      earlyIce.push(ice);
    } else {
      void sendIce(ice);
    }
  };

  // Offer and registration.
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);

  const resp = await postJson({ offer: peer.localDescription });
  if (!resp.ok) {
    peer.close();
    throw new Error(`Failed to create session: ${resp.status} ${resp.statusText}`);
  }
  const body = (await resp.json()) as { sessionId: string };
  sessionId = body.sessionId;
  console.log('[Creator] Session created:', sessionId);

  // Flush any ICE that was buffered before sessionId was known.
  for (const ice of earlyIce.splice(0)) void sendIce(ice);

  // ICE restart recovery on transport failure.
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryInFlight = false;
  const attemptRecovery = async () => {
    if (recoveryInFlight) return;
    const state = peer.connectionState;
    if (state !== 'failed' && state !== 'disconnected') return;
    recoveryInFlight = true;
    try {
      console.log('[Creator] Attempting ICE restart');
      const newOffer = await peer.createOffer({ iceRestart: true });
      await peer.setLocalDescription(newOffer);
      const r = await putJson({
        sessionId,
        role: 'creator',
        offer: peer.localDescription,
      });
      if (!r.ok) console.error('[Creator] Recovery PUT failed:', r.status);
    } catch (err) {
      console.error('[Creator] ICE restart failed:', err);
    } finally {
      recoveryInFlight = false;
    }
  };
  peer.addEventListener('connectionstatechange', () => {
    const state = peer.connectionState;
    console.log('[Creator] connection state:', state);
    if (state === 'failed' || state === 'disconnected') {
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(attemptRecovery, RECOVERY_DEBOUNCE_MS);
    } else if (state === 'connected') {
      if (recoveryTimer) {
        clearTimeout(recoveryTimer);
        recoveryTimer = null;
      }
    }
  });

  // Polling: pick up participant answers and their ICE candidates.
  const appliedAnswers = new Map<string, string>(); // participantId -> sdp
  const seenIce = new Set<string>();
  const pendingIce: RTCIceCandidateInit[] = [];

  const flushPendingIce = async () => {
    while (pendingIce.length > 0) {
      const ice = pendingIce.shift()!;
      try {
        await peer.addIceCandidate(ice);
      } catch (err) {
        console.warn('[Creator] deferred addIceCandidate failed:', err);
      }
    }
  };

  const pollOnce = async () => {
    const data = await fetchSession(sessionId!);
    const participants = data.participants ?? {};
    for (const [pid, p] of Object.entries(participants)) {
      if (p.answer?.sdp && appliedAnswers.get(pid) !== p.answer.sdp) {
        try {
          await peer.setRemoteDescription(p.answer);
          appliedAnswers.set(pid, p.answer.sdp);
          console.log('[Creator] Applied answer from', pid);
          await flushPendingIce();
        } catch (err) {
          console.error('[Creator] setRemoteDescription failed:', err);
        }
      }
      for (const ice of p.participantIce ?? []) {
        const key = iceKey(ice);
        if (seenIce.has(key)) continue;
        seenIce.add(key);
        if (peer.remoteDescription) {
          try {
            await peer.addIceCandidate(ice);
          } catch (err) {
            console.warn('[Creator] addIceCandidate failed:', err);
          }
        } else {
          pendingIce.push(ice);
        }
      }
    }
  };

  const stopPolling = startPollingLoop(pollOnce, () =>
    peer.connectionState === 'connected' ? SIGNAL_POLL_IDLE_MS : SIGNAL_POLL_ACTIVE_MS
  );

  let closed = false;
  return {
    peer,
    sessionId,
    sendReliable: (data) => messenger.sendReliable(data),
    sendUnreliable: (data) => messenger.sendUnreliable(data),
    onMessage: (h) => messenger.addMessageHandler(h),
    onChannelStateChange: (h) => {
      channelHandlers.add(h);
      return () => channelHandlers.delete(h);
    },
    onConnectionStateChange: (h) => {
      connHandlers.add(h);
      return () => connHandlers.delete(h);
    },
    getChannelState: () => channel.readyState,
    getConnectionState: () => peer.connectionState,
    close: () => {
      if (closed) return;
      closed = true;
      if (recoveryTimer) clearTimeout(recoveryTimer);
      stopPolling();
      messenger.close();
      try {
        channel.close();
      } catch {
        /* ignore */
      }
      try {
        peer.close();
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------- Participant ----------

export async function joinConnection(
  sessionId: string,
  participantId: string
): Promise<P2PConnection> {
  const peer = new RTCPeerConnection(ICE_CONFIGURATION);
  console.log('[Participant] Joining session:', sessionId);

  const channel = peer.createDataChannel('quizChannel', DATA_CHANNEL_INIT);
  console.log('[Participant] Data channel created with id', channel.id);

  const messenger = new ReliableMessenger(channel, '[Participant]');
  const channelHandlers = new Set<ChannelStateHandler>();
  const connHandlers = new Set<ConnectionStateHandler>();

  const notifyChannel = () => channelHandlers.forEach((h) => h(channel.readyState));
  const notifyConn = () => connHandlers.forEach((h) => h(peer.connectionState));

  channel.addEventListener('open', notifyChannel);
  channel.addEventListener('close', notifyChannel);
  channel.addEventListener('error', notifyChannel);
  peer.addEventListener('connectionstatechange', notifyConn);

  // ICE candidate dispatch; safe to register immediately, we always know sessionId here.
  peer.onicecandidate = async (event) => {
    if (!event.candidate) {
      console.log('[Participant] ICE gathering complete');
      return;
    }
    try {
      const r = await putJson({
        sessionId,
        participantId,
        role: 'participant',
        ice: event.candidate.toJSON(),
      });
      if (!r.ok) console.error('[Participant] ICE PUT rejected:', r.status);
    } catch (err) {
      console.error('[Participant] Failed to send ICE:', err);
    }
  };

  // Initial session fetch + answer publication.
  const initial = await fetchSession(sessionId, participantId);
  if (!initial.offer) {
    peer.close();
    throw new Error('No offer found for this session');
  }
  await applyOfferAndSendAnswer(peer, initial.offer, sessionId, participantId);
  let lastAppliedOfferSdp = initial.offer.sdp ?? '';

  const seenIce = new Set<string>();
  for (const ice of initial.creatorIce ?? []) {
    seenIce.add(iceKey(ice));
    try {
      await peer.addIceCandidate(ice);
    } catch (err) {
      console.warn('[Participant] initial addIceCandidate failed:', err);
    }
  }

  const pollOnce = async () => {
    const session = await fetchSession(sessionId, participantId);

    // Detect renegotiation (e.g. ICE restart from creator).
    if (session.offer?.sdp && session.offer.sdp !== lastAppliedOfferSdp) {
      console.log('[Participant] Applying renegotiated offer');
      try {
        await applyOfferAndSendAnswer(peer, session.offer, sessionId, participantId);
        lastAppliedOfferSdp = session.offer.sdp;
        // Creator-side ICE was cleared on renegotiation; fresh candidates will arrive.
        seenIce.clear();
      } catch (err) {
        console.error('[Participant] Failed to apply renegotiation:', err);
      }
    }

    for (const ice of session.creatorIce ?? []) {
      const key = iceKey(ice);
      if (seenIce.has(key)) continue;
      seenIce.add(key);
      try {
        await peer.addIceCandidate(ice);
      } catch (err) {
        console.warn('[Participant] addIceCandidate failed:', err);
      }
    }
  };

  const stopPolling = startPollingLoop(pollOnce, () =>
    peer.connectionState === 'connected' ? SIGNAL_POLL_IDLE_MS : SIGNAL_POLL_ACTIVE_MS
  );

  let closed = false;
  return {
    peer,
    sessionId,
    sendReliable: (data) => messenger.sendReliable(data),
    sendUnreliable: (data) => messenger.sendUnreliable(data),
    onMessage: (h) => messenger.addMessageHandler(h),
    onChannelStateChange: (h) => {
      channelHandlers.add(h);
      return () => channelHandlers.delete(h);
    },
    onConnectionStateChange: (h) => {
      connHandlers.add(h);
      return () => connHandlers.delete(h);
    },
    getChannelState: () => channel.readyState,
    getConnectionState: () => peer.connectionState,
    close: () => {
      if (closed) return;
      closed = true;
      stopPolling();
      messenger.close();
      try {
        channel.close();
      } catch {
        /* ignore */
      }
      try {
        peer.close();
      } catch {
        /* ignore */
      }
    },
  };
}

async function applyOfferAndSendAnswer(
  peer: RTCPeerConnection,
  offer: RTCSessionDescriptionInit,
  sessionId: string,
  participantId: string
): Promise<void> {
  await peer.setRemoteDescription(offer);
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);

  const r = await putJson({
    sessionId,
    participantId,
    role: 'participant',
    answer: peer.localDescription,
  });
  if (!r.ok) throw new Error(`Failed to send answer: ${r.status} ${r.statusText}`);
}
