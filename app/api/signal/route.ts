import { NextRequest, NextResponse } from 'next/server';

// =====================================================================
// In-memory signaling store.
//
// This file is developer-friendly but NOT production-hardened: the store
// lives in the Node process memory so it only works with a single-instance
// server. The public API:
//
//   POST /api/signal            { offer }                     -> { sessionId }
//   PUT  /api/signal            { sessionId, role:'creator', offer?|ice? }
//                                { sessionId, participantId, role:'participant', answer?|ice? }
//   GET  /api/signal?session=X                          -> { participants: {...} }
//   GET  /api/signal?session=X&participant=Y            -> { offer, creatorIce }
//
// Participants are created implicitly by their first PUT. GET never mutates
// state beyond refreshing `lastSeen` for the polling participant.
// =====================================================================

type Participant = {
  answer?: RTCSessionDescriptionInit;
  participantIce: RTCIceCandidateInit[];
  lastSeen: number;
};

type SessionConnection = {
  offer: RTCSessionDescriptionInit;
  creatorIce: RTCIceCandidateInit[];
  participants: Map<string, Participant>;
  createdAt: number;
  lastSeen: number;
};

// Preserve the store across dev-mode hot reloads.
const globalStore = globalThis as unknown as {
  __p2pQuizConnections?: Map<string, SessionConnection>;
  __p2pQuizCleanup?: ReturnType<typeof setInterval>;
};

const connections: Map<string, SessionConnection> =
  globalStore.__p2pQuizConnections ?? new Map<string, SessionConnection>();
globalStore.__p2pQuizConnections = connections;

const SESSION_MAX_IDLE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function generateSessionId(): string {
  // 96 random bits encoded as hex for collision resistance.
  const buf = new Uint8Array(12);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function cleanupOldSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of connections.entries()) {
    let lastActivity = session.lastSeen;
    for (const p of session.participants.values()) {
      if (p.lastSeen > lastActivity) lastActivity = p.lastSeen;
    }
    if (now - lastActivity > SESSION_MAX_IDLE_MS) {
      console.log(`[signal] cleaning up idle session ${sessionId}`);
      connections.delete(sessionId);
    }
  }
}

if (!globalStore.__p2pQuizCleanup) {
  globalStore.__p2pQuizCleanup = setInterval(cleanupOldSessions, CLEANUP_INTERVAL_MS);
}

function touch(session: SessionConnection): void {
  session.lastSeen = Date.now();
}

// ---------- Handlers ----------

export async function GET(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const sessionId = searchParams.get('session');
  const participantId = searchParams.get('participant');

  if (!sessionId) {
    return NextResponse.json({ error: 'Session ID is required' }, { status: 400 });
  }

  const session = connections.get(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  touch(session);

  if (participantId) {
    // Refresh participant's lastSeen if we already know about them; do NOT
    // auto-create here — participants only exist once they PUT their answer
    // or an ICE candidate. This prevents random pollers from populating the
    // creator's participants list.
    const p = session.participants.get(participantId);
    if (p) p.lastSeen = Date.now();

    return NextResponse.json({
      offer: session.offer,
      creatorIce: session.creatorIce,
    });
  }

  const participantsObj: Record<
    string,
    { answer?: RTCSessionDescriptionInit; participantIce: RTCIceCandidateInit[]; lastSeen: number }
  > = {};
  for (const [pid, p] of session.participants.entries()) {
    participantsObj[pid] = {
      answer: p.answer,
      participantIce: p.participantIce,
      lastSeen: p.lastSeen,
    };
  }
  return NextResponse.json({ participants: participantsObj });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { offer?: RTCSessionDescriptionInit };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.offer || typeof body.offer.sdp !== 'string') {
    return NextResponse.json({ error: 'Valid offer is required' }, { status: 400 });
  }

  const sessionId = generateSessionId();
  const now = Date.now();
  connections.set(sessionId, {
    offer: body.offer,
    creatorIce: [],
    participants: new Map(),
    createdAt: now,
    lastSeen: now,
  });

  return NextResponse.json({ sessionId });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  let body: {
    sessionId?: string;
    participantId?: string;
    role?: 'creator' | 'participant';
    answer?: RTCSessionDescriptionInit;
    offer?: RTCSessionDescriptionInit;
    ice?: RTCIceCandidateInit;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { sessionId, participantId, answer, ice, offer, role } = body;
  if (!sessionId) {
    return NextResponse.json({ error: 'Session ID is required' }, { status: 400 });
  }

  const session = connections.get(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  touch(session);

  const getOrCreateParticipant = (pid: string): Participant => {
    let p = session.participants.get(pid);
    if (!p) {
      p = { participantIce: [], lastSeen: Date.now() };
      session.participants.set(pid, p);
    }
    return p;
  };

  // Creator renegotiation (e.g. ICE restart).
  if (offer && role === 'creator') {
    if (typeof offer.sdp !== 'string') {
      return NextResponse.json({ error: 'Invalid offer' }, { status: 400 });
    }
    session.offer = offer;
    // ICE candidates from the previous negotiation are no longer valid
    // (new ufrag/pwd), so drop them and let fresh ones be published.
    session.creatorIce = [];
  }

  // ICE candidate publication.
  if (ice) {
    if (role === 'creator') {
      session.creatorIce.push(ice);
    } else if (role === 'participant' && participantId) {
      const p = getOrCreateParticipant(participantId);
      p.participantIce.push(ice);
      p.lastSeen = Date.now();
    } else {
      return NextResponse.json(
        { error: 'ICE requires role and (for participant) participantId' },
        { status: 400 }
      );
    }
  }

  // Participant answer publication (supports updates during renegotiation).
  if (answer) {
    if (!participantId) {
      return NextResponse.json({ error: 'participantId required for answer' }, { status: 400 });
    }
    if (typeof answer.sdp !== 'string') {
      return NextResponse.json({ error: 'Invalid answer' }, { status: 400 });
    }
    const p = getOrCreateParticipant(participantId);
    p.answer = answer;
    p.lastSeen = Date.now();
  }

  return NextResponse.json({ success: true });
}
