export async function createConnection() {
    const creatorPeer = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun3.l.google.com:19302" },
        { urls: "stun:stun4.l.google.com:19302" }
      ]
    });
  
    const dataChannel = creatorPeer.createDataChannel("quizChannel", {
      ordered: true
    });
  
    // Add connection state change handler
    creatorPeer.onconnectionstatechange = () => {
      console.log("[Creator] Connection state:", creatorPeer.connectionState);
    };
  
    creatorPeer.oniceconnectionstatechange = () => {
      console.log("[Creator] ICE Connection state:", creatorPeer.iceConnectionState);
    };
  
    dataChannel.onopen = () => {
      console.log("[Creator] Data Channel is open!");
    };
  
    dataChannel.onclose = () => {
      console.log("[Creator] Data Channel closed!");
    };
  
    dataChannel.onerror = (error) => {
      console.error("[Creator] Data Channel error:", error);
    };
  
    dataChannel.onmessage = (event) => {
      console.log("[Creator] Received message:", event.data);
    };
  
    const offer = await creatorPeer.createOffer();
    await creatorPeer.setLocalDescription(offer);
  
    // Wait for ICE gathering to complete
    await new Promise<void>((resolve) => {
      if (creatorPeer.iceGatheringState === 'complete') {
        resolve();
      } else {
        creatorPeer.onicegatheringstatechange = () => {
          if (creatorPeer.iceGatheringState === 'complete') {
            resolve();
          }
        };
      }
    });
  
    // Create session on signaling server with the complete offer
    const response = await fetch('/api/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        offer: creatorPeer.localDescription 
      })
    });
    const { sessionId } = await response.json();
  
    // Start polling for answer and ICE candidates
    let hasReceivedAnswer = false;
    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`/api/signal?sessionId=${sessionId}`);
        const session = await response.json();
  
        if (!hasReceivedAnswer && session.answer) {
          await creatorPeer.setRemoteDescription(session.answer);
          hasReceivedAnswer = true;
        }
  
        if (session.participantIce?.length) {
          for (const ice of session.participantIce) {
            try {
              await creatorPeer.addIceCandidate(new RTCIceCandidate(ice));
            } catch (err) {
              console.error('[Creator] Failed to add ICE candidate:', err);
            }
          }
        }
  
        if (creatorPeer.connectionState === 'connected') {
          clearInterval(pollInterval);
        }
      } catch (error) {
        console.error('Error polling updates:', error);
      }
    }, 1000);
  
    // Setup ICE candidate handling
    creatorPeer.onicecandidate = async (event) => {
      if (event.candidate) {
        try {
          await fetch('/api/signal', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              ice: event.candidate.toJSON(),
              role: 'creator'
            })
          });
        } catch (err) {
          console.error('[Creator] Failed to send ICE candidate:', err);
        }
      }
    };
  
    return { creatorPeer, dataChannel, sessionId };
  }
  
  export async function setParticipantAnswer(
    creatorPeer: RTCPeerConnection,
    answer: RTCSessionDescriptionInit
  ) {
    await creatorPeer.setRemoteDescription(answer);
  }
  
  export function addParticipantIceCandidate(
    creatorPeer: RTCPeerConnection,
    candidate: RTCIceCandidate
  ) {
    creatorPeer.addIceCandidate(candidate);
  }
  
  export async function joinConnection(sessionId: string) {
    // Get session info from signaling server
    const response = await fetch(`/api/signal?sessionId=${sessionId}`);
    const session = await response.json();
    
    if (!session.offer) {
      throw new Error('No offer found for this session');
    }
  
    const participantPeer = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun3.l.google.com:19302" },
        { urls: "stun:stun4.l.google.com:19302" }
      ]
    });
  
    let receiveChannel: RTCDataChannel | null = null;
  
    // Add connection state change handlers
    participantPeer.onconnectionstatechange = () => {
      console.log("[Participant] Connection state:", participantPeer.connectionState);
    };
  
    participantPeer.oniceconnectionstatechange = () => {
      console.log("[Participant] ICE Connection state:", participantPeer.iceConnectionState);
    };
  
    // Handle data channel
    participantPeer.ondatachannel = (event) => {
      receiveChannel = event.channel;
      console.log("[Participant] Data channel received");
  
      receiveChannel.onopen = () => {
        console.log("[Participant] Data Channel is open!");
      };
  
      receiveChannel.onclose = () => {
        console.log("[Participant] Data Channel closed!");
      };
  
      receiveChannel.onerror = (error) => {
        console.error("[Participant] Data Channel error:", error);
      };
    };
  
    // Set up ICE candidate handling
    participantPeer.onicecandidate = async (event) => {
      if (event.candidate) {
        try {
          await fetch('/api/signal', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              ice: event.candidate.toJSON(),
              role: 'participant'
            })
          });
        } catch (err) {
          console.error('[Participant] Failed to send ICE candidate:', err);
        }
      }
    };
  
    // Set remote description (offer)
    await participantPeer.setRemoteDescription(session.offer);
  
    // Create and set local description (answer)
    const answer = await participantPeer.createAnswer();
    await participantPeer.setLocalDescription(answer);
  
    // Wait for ICE gathering to complete
    await new Promise<void>((resolve) => {
      if (participantPeer.iceGatheringState === 'complete') {
        resolve();
      } else {
        participantPeer.onicegatheringstatechange = () => {
          if (participantPeer.iceGatheringState === 'complete') {
            resolve();
          }
        };
      }
    });
  
    // Send answer to signaling server
    await fetch('/api/signal', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        sessionId, 
        answer: participantPeer.localDescription 
      })
    });
  
    // Add any existing ICE candidates
    if (session.creatorIce?.length) {
      for (const ice of session.creatorIce) {
        try {
          await participantPeer.addIceCandidate(new RTCIceCandidate(ice));
        } catch (err) {
          console.error('[Participant] Failed to add ICE candidate:', err);
        }
      }
    }
  
    // Start polling for new ICE candidates
    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`/api/signal?sessionId=${sessionId}`);
        const session = await response.json();
  
        if (session.creatorIce?.length) {
          for (const ice of session.creatorIce) {
            try {
              await participantPeer.addIceCandidate(new RTCIceCandidate(ice));
            } catch (err) {
              console.error('[Participant] Failed to add ICE candidate:', err);
            }
          }
        }
  
        if (participantPeer.connectionState === 'connected') {
          clearInterval(pollInterval);
        }
      } catch (error) {
        console.error('Error polling updates:', error);
      }
    }, 1000);
  
    return {
      participantPeer,
      getChannel: () => receiveChannel
    };
  }
  
  export function addCreatorIceCandidate(
    participantPeer: RTCPeerConnection,
    candidate: RTCIceCandidate
  ) {
    participantPeer.addIceCandidate(candidate);
  }
  
  // Poll for updates (new ICE candidates)
  export async function pollUpdates(sessionId: string, role: 'creator' | 'participant', peer: RTCPeerConnection) {
    let processedIceCandidates = new Set<string>();
  
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/signal?sessionId=${sessionId}`);
        const session = await response.json();
  
        if (role === 'creator' && session.participantIce?.length) {
          for (const ice of session.participantIce) {
            const iceString = JSON.stringify(ice);
            if (!processedIceCandidates.has(iceString)) {
              try {
                await peer.addIceCandidate(new RTCIceCandidate(ice));
                processedIceCandidates.add(iceString);
              } catch (err) {
                console.error('[Creator] Failed to add ICE candidate:', err);
              }
            }
          }
        } else if (role === 'participant' && session.creatorIce?.length) {
          for (const ice of session.creatorIce) {
            const iceString = JSON.stringify(ice);
            if (!processedIceCandidates.has(iceString)) {
              try {
                await peer.addIceCandidate(new RTCIceCandidate(ice));
                processedIceCandidates.add(iceString);
              } catch (err) {
                console.error('[Participant] Failed to add ICE candidate:', err);
              }
            }
          }
        }
  
        if (peer.connectionState === 'connected') {
          clearInterval(interval);
        }
      } catch (error) {
        console.error('Error polling updates:', error);
      }
    }, 1000);
  
    return () => clearInterval(interval);
  }