import { NextRequest, NextResponse } from 'next/server';

// Store connections in memory
type SessionConnection = {
  offer: RTCSessionDescriptionInit;
  creatorIce: RTCIceCandidateInit[];
  participants: Map<string, {
    answer?: RTCSessionDescriptionInit;
    participantIce: RTCIceCandidateInit[];
    lastSeen: number; // Add timestamp for tracking activity
  }>;
};

const connections = new Map<string, SessionConnection>();

// Helper to generate session ID
function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

// Helper to clean up old sessions (run periodically)
function cleanupOldSessions() {
  const now = Date.now();
  const MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
  
  for (const [sessionId, session] of connections.entries()) {
    // Check if this session is too old
    let allParticipantsInactive = true;
    
    for (const [participantId, participant] of session.participants.entries()) {
      if (now - participant.lastSeen < MAX_AGE) {
        allParticipantsInactive = false;
        break;
      }
    }
    
    if (allParticipantsInactive) {
      console.log(`Cleaning up inactive session: ${sessionId}`);
      connections.delete(sessionId);
    }
  }
}

// Run cleanup every hour
setInterval(cleanupOldSessions, 60 * 60 * 1000);

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const sessionId = searchParams.get('session');
  const participantId = searchParams.get('participant');

  if (!sessionId) {
    return NextResponse.json({ error: 'Session ID is required' }, { status: 400 });
  }

  const connection = connections.get(sessionId);
  if (!connection) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  if (participantId) {
    // If the participant doesn't exist in this session yet, create a new entry
    if (!connection.participants.has(participantId)) {
      connection.participants.set(participantId, {
        participantIce: [],
        lastSeen: Date.now()
      });
    } else {
      // Update last seen timestamp
      const participant = connection.participants.get(participantId);
      if (participant) {
        participant.lastSeen = Date.now();
        connection.participants.set(participantId, participant);
      }
    }
    
    // Return session info for this participant
    const participant = connection.participants.get(participantId);
    
    return NextResponse.json({
      offer: connection.offer,
      creatorIce: connection.creatorIce,
      participant: participant
    });
  } else {
    // Return session info for creator (all participants)
    const participantsObj: Record<string, any> = {};
    
    // Convert Map to object for JSON response
    for (const [pid, pData] of connection.participants.entries()) {
      participantsObj[pid] = {
        answer: pData.answer,
        participantIce: pData.participantIce,
        lastSeen: pData.lastSeen
      };
    }
    
    return NextResponse.json({
      participants: participantsObj
    });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  if (!body.offer) {
    return NextResponse.json({ error: 'Offer is required' }, { status: 400 });
  }

  // Check for existing session with the same SDP
  const now = Date.now();
  const threshold = 30 * 60 * 1000; // 30 minutes
  let existingSessionId = null;
  
  // Look for a recently created session from the same peer
  for (const [sessionId, session] of connections.entries()) {
    // Skip sessions older than threshold
    let anyRecentParticipants = false;
    for (const participant of session.participants.values()) {
      if (now - participant.lastSeen < threshold) {
        anyRecentParticipants = true;
        break;
      }
    }
    
    // If session has offer SDP and is recent, it's likely from the same creator
    if (session.offer?.sdp === body.offer.sdp) {
      console.log(`Found existing session with matching offer: ${sessionId}`);
      existingSessionId = sessionId;
      break;
    }
  }
  
  // If we found an existing session, return that
  if (existingSessionId) {
    console.log(`Returning existing session ID: ${existingSessionId}`);
    
    // Update offer just in case there were changes
    const existingSession = connections.get(existingSessionId);
    if (existingSession) {
      existingSession.offer = body.offer;
      // Don't clear ICE candidates, they might still be valid
    }
    
    return NextResponse.json({ sessionId: existingSessionId });
  }
  
  // Create new session if no existing one found
  const sessionId = generateId();
  
  connections.set(sessionId, {
    offer: body.offer,
    creatorIce: [],
    participants: new Map()
  });

  return NextResponse.json({ sessionId });
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  const { sessionId, participantId, answer, ice, role } = body;

  if (!sessionId) {
    return NextResponse.json({ error: 'Session ID is required' }, { status: 400 });
  }

  const connection = connections.get(sessionId);
  if (!connection) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // Handle ICE candidates
  if (ice) {
    if (role === 'creator') {
      connection.creatorIce.push(ice);
    } else if (role === 'participant' && participantId) {
      // Create participant entry if it doesn't exist
      if (!connection.participants.has(participantId)) {
        connection.participants.set(participantId, {
          participantIce: [ice],
          lastSeen: Date.now()
        });
      } else {
        const participant = connection.participants.get(participantId);
        if (participant) {
          participant.participantIce.push(ice);
          participant.lastSeen = Date.now();
          connection.participants.set(participantId, participant);
        }
      }
    } else {
      return NextResponse.json({ error: 'Invalid role or missing participant ID' }, { status: 400 });
    }
  }

  // Handle offer (renegotiation)
  if (body.offer && role === 'creator') {
    connection.offer = body.offer;
    // Clear existing ICE candidates on renegotiation
    connection.creatorIce = [];
  }

  // Handle answer
  if (answer && participantId) {
    // Allow updating answer for existing participant (reconnection scenario)
    const existingParticipant = connection.participants.get(participantId);
    
    if (existingParticipant) {
      existingParticipant.answer = answer;
      existingParticipant.lastSeen = Date.now();
      // Don't clear ICE candidates on reconnection, they might still be valid
      connection.participants.set(participantId, existingParticipant);
    } else {
      // New participant
      connection.participants.set(participantId, {
        answer,
        participantIce: [],
        lastSeen: Date.now()
      });
    }
  }

  return NextResponse.json({ success: true });
} 