import { NextResponse } from 'next/server';

// In-memory store for offers and answers (in production, use Redis or similar)
const connections = new Map<string, {
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  creatorIce: RTCIceCandidateInit[];
  participantIce: RTCIceCandidateInit[];
  lastUpdated: number;
}>();

// Clean up old sessions (older than 1 hour)
const cleanup = () => {
  const now = Date.now();
  for (const [sessionId, session] of connections.entries()) {
    if (now - session.lastUpdated > 3600000) {
      connections.delete(sessionId);
    }
  }
};

// Create a new quiz session
export async function POST(request: Request) {
  try {
    cleanup();
    const { offer } = await request.json();
    const sessionId = Math.random().toString(36).substring(2, 15);
    
    connections.set(sessionId, {
      offer,
      creatorIce: [],
      participantIce: [],
      lastUpdated: Date.now()
    });

    return NextResponse.json({ sessionId });
  } catch (error) {
    console.error('Failed to create session:', error);
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 });
  }
}

// Get session info or update with answer/ICE candidates
export async function PUT(request: Request) {
  try {
    cleanup();
    const { sessionId, answer, ice, role } = await request.json();
    const session = connections.get(sessionId);

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    if (answer) {
      session.answer = answer;
    }

    if (ice) {
      // Avoid duplicate ICE candidates
      const iceString = JSON.stringify(ice);
      if (role === 'creator') {
        if (!session.creatorIce.some(c => JSON.stringify(c) === iceString)) {
          session.creatorIce.push(ice);
        }
      } else {
        if (!session.participantIce.some(c => JSON.stringify(c) === iceString)) {
          session.participantIce.push(ice);
        }
      }
    }

    session.lastUpdated = Date.now();
    connections.set(sessionId, session);

    return NextResponse.json(session);
  } catch (error) {
    console.error('Failed to update session:', error);
    return NextResponse.json({ error: 'Failed to update session' }, { status: 500 });
  }
}

// Get session info
export async function GET(request: Request) {
  try {
    cleanup();
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');

    if (!sessionId) {
      return NextResponse.json({ error: 'Session ID required' }, { status: 400 });
    }

    const session = connections.get(sessionId);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    session.lastUpdated = Date.now();
    connections.set(sessionId, session);

    return NextResponse.json(session);
  } catch (error) {
    console.error('Failed to get session:', error);
    return NextResponse.json({ error: 'Failed to get session' }, { status: 500 });
  }
} 