import { getHostAddress } from './utils';

interface QueuedMessage {
  id: string;
  data: string;
  attempts: number;
  maxAttempts: number;
  timestamp: number;
}

class MessageQueue {
  private queue: Map<string, QueuedMessage> = new Map();
  private channel: RTCDataChannel;
  private pendingMessages: Set<string> = new Set();
  private retryInterval: ReturnType<typeof setInterval> | null = null;
  private maxRetryInterval = 5000; // Max 5 seconds between retries
  private acknowledgedMessages: Set<string> = new Set();
  private messageIdToQueueId: Map<string, string> = new Map();
  private submittedAnswers: Set<string> = new Set(); // Track submitted answers by quizId
  private completedQuizzes: Set<string> = new Set(); // NEW: Track fully completed quizzes
  
  constructor(channel: RTCDataChannel) {
    this.channel = channel;
    this.startRetryTimer();
  }
  
  // Enqueue a message for sending
  enqueue(data: string, maxAttempts = 5): string {
    try {
      const parsedData = JSON.parse(data);
      
      // Special handling for answer messages to prevent duplicates
      if (parsedData.type === 'answer') {
        const answerData = JSON.parse(parsedData.payload);
        const quizId = answerData.quizId;
        
        // If this quiz is marked as completed, don't send any more messages for it
        if (this.completedQuizzes.has(quizId)) {
          console.log(`[MessageQueue] Quiz ${quizId} is completed, ignoring new messages`);
          return '';
        }
        
        // If we've already submitted an answer for this quiz, don't submit again
        if (this.submittedAnswers.has(quizId)) {
          console.log(`[MessageQueue] Answer already submitted for quiz ${quizId}, ignoring duplicate`);
          return '';
        }
        
        // Remove any existing answer messages for this quiz from the queue
        for (const [msgId, msg] of this.queue.entries()) {
          try {
            const existingData = JSON.parse(msg.data);
            if (existingData.type === 'answer') {
              const existingAnswer = JSON.parse(existingData.payload);
              if (existingAnswer.quizId === quizId) {
                console.log(`[MessageQueue] Removing old answer message for quiz ${quizId}`);
                this.queue.delete(msgId);
                this.pendingMessages.delete(msgId);
              }
            }
          } catch (err) {
            // Skip if we can't parse the message
          }
        }
        
        // Mark this quiz as having a submitted answer
        this.submittedAnswers.add(quizId);
      }
    } catch (err) {
      // Not JSON or couldn't parse, continue with normal processing
    }
    
    const id = Math.random().toString(36).substring(2);
    
    // Parse the message to extract original ID if it exists
    try {
      const parsedData = JSON.parse(data);
      if (parsedData.messageId) {
        // Store the mapping from messageId to queue id
        this.messageIdToQueueId.set(parsedData.messageId, id);
        
        // Check if this message was already acknowledged
        if (this.acknowledgedMessages.has(parsedData.messageId)) {
          console.log(`[MessageQueue] Message ${parsedData.messageId} was already acknowledged, not resending`);
          return parsedData.messageId;
        }
      }
    } catch (err) {
      // Not JSON or couldn't parse, continue with normal processing
    }
    
    const message: QueuedMessage = {
      id,
      data,
      attempts: 0,
      maxAttempts,
      timestamp: Date.now()
    };
    
    this.queue.set(id, message);
    this.trySend(id);
    return id;
  }
  
  // Try to send a specific message
  private trySend(id: string): boolean {
    // Check if message is already acknowledged
    if (this.acknowledgedMessages.has(id)) {
      // Remove silently
      this.queue.delete(id);
      return true;
    }
    
    // Check if channel is open
    if (this.channel.readyState !== 'open') {
      return false;
    }
    
    // Check if message is in queue
    const message = this.queue.get(id);
    if (!message) return false;
    
    // Check if message is already pending acknowledgment
    if (this.pendingMessages.has(id)) {
      return false;
    }
    
    try {
      const parsedData = JSON.parse(message.data);
      if (parsedData.type === 'answer') {
        const answerData = JSON.parse(parsedData.payload);
        const quizId = answerData.quizId;
        
        // If this quiz is completed, remove the message and don't send
        if (this.completedQuizzes.has(quizId)) {
          this.queue.delete(id);
          return false;
        }
        
        // If this answer has been attempted more than once, don't retry
        if (message.attempts > 0) {
          console.log(`[MessageQueue] Answer for quiz ${quizId} already attempted, removing from queue`);
          this.queue.delete(id);
          return false;
        }
      }
    } catch (err) {
      // Not JSON or couldn't parse, continue with normal processing
    }
    
    // Only attempt to send if we haven't reached max attempts
    if (message.attempts >= message.maxAttempts) {
      console.log(`[MessageQueue] Max attempts (${message.maxAttempts}) reached for message ${id}, dropping`);
      this.queue.delete(id);
      return false;
    }
    
    try {
      // Increment attempts before sending to prevent rapid retry on error
      message.attempts++;
      
      // Set as pending before sending
      this.pendingMessages.add(id);
      
      // Parse message to see what's being sent (for debugging)
      try {
        const parsedMessage = JSON.parse(message.data);
        // Only log non-ACK messages being sent
        if (parsedMessage.type !== 'ack') {
          if (message.attempts === 1) {
            console.log(`[MessageQueue] Sending ${parsedMessage.type} message`);
          } else {
            console.log(`[MessageQueue] Retrying ${parsedMessage.type} message, attempt ${message.attempts}/${message.maxAttempts}`);
          }
        }
        
        // Special case for ACK messages - don't wait for acknowledgment
        if (parsedMessage.type === 'ack') {
          // Remove from queue immediately since ACKs don't need acknowledgment themselves
          this.pendingMessages.delete(id);
          this.queue.delete(id);
        }
      } catch (err) {
        // If parsing fails, just send without logging
      }
      
      // Send the message
      this.channel.send(message.data);
      
      // Different timeout durations for different message types
      let timeoutDuration = 3000; // Default 3 seconds
      try {
        const parsedData = JSON.parse(message.data);
        if (parsedData.type === 'answer') {
          timeoutDuration = 1000; // Shorter timeout for answers (1 second)
        } else if (parsedData.type === 'ack') {
          timeoutDuration = 500; // Very short timeout for ACKs (0.5 seconds)
        }
      } catch (err) {
        // Use default timeout if parsing fails
      }
      
      // Set timeout to consider message as failed if no ACK received
      setTimeout(() => {
        if (this.pendingMessages.has(id) && !this.acknowledgedMessages.has(id)) {
          // Only log timeout for non-ACK messages
          try {
            const parsedData = JSON.parse(message.data);
            if (parsedData.type !== 'ack') {
              console.log(`[MessageQueue] Message ${parsedData.type} timed out, will retry`);
            }
          } catch (err) {
            // If we can't parse, assume it's not an ACK and log
            console.log(`[MessageQueue] Message timed out, will retry`);
          }
          
          this.pendingMessages.delete(id);
          
          try {
            const parsedData = JSON.parse(message.data);
            if (parsedData.type === 'answer') {
              const answerData = JSON.parse(parsedData.payload);
              const quizId = answerData.quizId;
              
              // Mark quiz as completed even if we don't get ACK
              this.completedQuizzes.add(quizId);
              console.log(`[MessageQueue] Marking quiz ${quizId} as completed after timeout`);
              this.queue.delete(id);
            }
          } catch (err) {
            // Not JSON or couldn't parse, continue with normal processing
          }
        }
      }, timeoutDuration);
      
      return true;
    } catch (err) {
      console.error(`[MessageQueue] Error sending message:`, err);
      this.pendingMessages.delete(id);
      return false;
    }
  }
  
  // Mark a message as successfully delivered (called when ACK received)
  acknowledge(id: string): void {
    // Check if this is a messageId (from the message) rather than a queue ID
    const queueId = this.messageIdToQueueId.get(id) || id;
    
    // Get the message data to check if it's an answer
    const message = this.queue.get(queueId);
    if (message) {
      try {
        const parsedData = JSON.parse(message.data);
        if (parsedData.type === 'answer') {
          const answerData = JSON.parse(parsedData.payload);
          const quizId = answerData.quizId;
          console.log(`[MessageQueue] Acknowledged answer for quiz ${quizId}`);
          
          // Mark the quiz as completed when we get acknowledgment
          this.completedQuizzes.add(quizId);
          
          // Remove all pending messages for this quiz
          for (const [msgId, msg] of this.queue.entries()) {
            try {
              const data = JSON.parse(msg.data);
              if (data.type === 'answer') {
                const payload = JSON.parse(data.payload);
                if (payload.quizId === quizId) {
                  console.log(`[MessageQueue] Removing redundant message for completed quiz ${quizId}`);
                  this.queue.delete(msgId);
                  this.pendingMessages.delete(msgId);
                }
              }
            } catch (err) {
              // Skip if we can't parse the message
            }
          }
        }
      } catch (err) {
        // Not JSON or couldn't parse, continue with normal processing
      }
    }
    
    // Remove from pending and queue
    this.pendingMessages.delete(queueId);
    this.queue.delete(queueId);
    
    // Add both IDs to acknowledged set
    this.acknowledgedMessages.add(id);
    this.acknowledgedMessages.add(queueId);
    
    // Clean up old acknowledgments if we have too many
    if (this.acknowledgedMessages.size > 100) {
      const toRemove = Array.from(this.acknowledgedMessages).slice(0, 50);
      toRemove.forEach(msgId => this.acknowledgedMessages.delete(msgId));
    }
  }
  
  // Start the retry timer
  private startRetryTimer(): void {
    if (this.retryInterval) clearInterval(this.retryInterval);
    
    this.retryInterval = setInterval(() => {
      // Only process if we have items and channel is open
      if (this.queue.size > 0 && this.channel.readyState === 'open') {
        // Count non-ACK messages in queue
        let nonAckCount = 0;
        let hasAnswerMessages = false;
        
        for (const [_, message] of this.queue.entries()) {
          try {
            const parsedData = JSON.parse(message.data);
            if (parsedData.type !== 'ack') {
              nonAckCount++;
              if (parsedData.type === 'answer') {
                hasAnswerMessages = true;
              }
            }
          } catch (err) {
            nonAckCount++; // If we can't parse, count it
          }
        }
        
        // Only log if there are answer messages in the queue
        if (hasAnswerMessages) {
          console.log(`[MessageQueue] Retry timer: processing ${nonAckCount} messages, including answers`);
        }
        
        // Process messages
        for (const [id, message] of this.queue.entries()) {
          // Skip messages that are pending ACK
          if (this.pendingMessages.has(id)) continue;
          
          // Skip messages that have been acknowledged
          if (this.acknowledgedMessages.has(id)) {
            this.queue.delete(id);
            continue;
          }
          
          // If we've reached max attempts, remove from queue
          if (message.attempts >= message.maxAttempts) {
            try {
              const parsedData = JSON.parse(message.data);
              if (parsedData.type !== 'ack') {
                console.log(`[MessageQueue] Max attempts reached for ${parsedData.type} message, dropping`);
              }
            } catch (err) {
              // If we can't parse, just log generic message
              console.log(`[MessageQueue] Max attempts reached for message, dropping`);
            }
            this.queue.delete(id);
            continue;
          }
          
          // Otherwise try to send
          this.trySend(id);
        }
      }
    }, 1000); // Check every second
  }
  
  // Stop the retry timer (when shutting down)
  stop(): void {
    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }
  }
}

// Update the ICE server configuration for both creator and participant
export function getICEConfiguration(): RTCConfiguration {
  return {
    iceServers: [
      {
        urls: [
          'stun:stun1.l.google.com:19302',
          'stun:stun2.l.google.com:19302',
          'stun:stun3.l.google.com:19302',
          'stun:stun4.l.google.com:19302'
        ]
      }
    ],
    iceTransportPolicy: 'all',
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  };
}

// Add connection quality monitoring
function monitorConnectionQuality(peer: RTCPeerConnection) {
  let lastStats = new Map<string, RTCStats>();
  
  setInterval(async () => {
    try {
      const stats = await peer.getStats();
      stats.forEach(stat => {
        if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
          const previousStat = lastStats.get(stat.id);
          if (previousStat && 'currentRoundTripTime' in stat) {
            const rtt = (stat as any).currentRoundTripTime * 1000; // Convert to ms
            console.log(`Connection RTT: ${rtt}ms`);
            
            // Log warning if RTT is high
            if (rtt > 500) {
              console.warn('High latency detected');
            }
          }
        }
        lastStats.set(stat.id, stat);
      });
    } catch (err) {
      console.error('Error monitoring connection quality:', err);
    }
  }, 2000);
}

export async function createConnection() {
    const creatorPeer = new RTCPeerConnection(getICEConfiguration());
    console.log("[Creator] Creating RTCPeerConnection");
  
    // Create data channel with more reliable settings
    const dataChannel = creatorPeer.createDataChannel("quizChannel", {
      ordered: true,
      maxRetransmits: 30, // Increased from 10
      protocol: 'quiz',
      negotiated: true,
      id: 0
    });
  
    console.log("[Creator] Data channel created with ID:", dataChannel.id);
  
    // Set up all event handlers with better error handling
    dataChannel.onopen = () => {
      console.log("[Creator] Data Channel opened");
      // Reset any error state when connection is successful
      if (typeof window !== 'undefined') {
        const errorElement = document.querySelector('.error-message') as HTMLElement;
        if (errorElement) errorElement.style.display = 'none';
      }
    };
  
    dataChannel.onerror = (event) => {
      console.error("[Creator] Data Channel error:", event);
      if (dataChannel.readyState === 'closed') {
        // Try to reestablish the data channel
        try {
          const newDataChannel = creatorPeer.createDataChannel("quizChannel", {
            ordered: true,
            maxRetransmits: 10,
            protocol: 'quiz'
          });
          Object.assign(dataChannel, newDataChannel);
        } catch (err) {
          console.error("[Creator] Failed to recreate data channel:", err);
        }
      }
    };
  
    dataChannel.onclose = () => {
      console.log("[Creator] Data Channel closed");
      // Attempt to reopen if closed unexpectedly
      if (creatorPeer.connectionState === 'connected') {
        console.log("[Creator] Attempting to reopen data channel");
        try {
          const newDataChannel = creatorPeer.createDataChannel("quizChannel", {
            ordered: true,
            maxRetransmits: 10,
            protocol: 'quiz'
          });
          Object.assign(dataChannel, newDataChannel);
        } catch (err) {
          console.error("[Creator] Failed to reopen data channel:", err);
        }
      }
    };
  
    // Create persistent sets to track processed message IDs
    const processedMessageIds = new Set<string>();
    const messageQueues = new Map<string, MessageQueue>();

    // Create offer first
    console.log("[Creator] Creating offer");
    const offerOptions: RTCOfferOptions = {
      offerToReceiveAudio: false,
      offerToReceiveVideo: false,
      iceRestart: false
    };
  
    const offer = await creatorPeer.createOffer(offerOptions);
    await creatorPeer.setLocalDescription(offer);
    console.log("[Creator] Local description set");
  
    // Create session on signaling server with the offer
    console.log("[Creator] Sending offer to signaling server");
    
    // Use the current origin for API calls on the creator side
    const response = await fetch('/api/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        offer: creatorPeer.localDescription 
      })
    });
  
    if (!response.ok) {
      throw new Error('Failed to create session on signaling server');
    }
  
    const { sessionId } = await response.json();
    console.log("[Creator] Session created with ID:", sessionId);

    // Initialize message queue after we have the sessionId
    const messageQueue = new MessageQueue(dataChannel);
    messageQueues.set(sessionId, messageQueue);

    dataChannel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        // Handle ACK messages silently
        if (data.type === 'ack' && data.messageId) {
          const messageQueue = messageQueues.get(sessionId);
          if (messageQueue) {
            messageQueue.acknowledge(data.messageId);
          }
          return; // Don't process ACKs further
        }
        
        // For non-ACK messages that have a messageId, send ACK only if not processed before
        if (data.messageId && !processedMessageIds.has(data.messageId)) {
          processedMessageIds.add(data.messageId);
          
          // Only send ACK for messages that require reliability
          if (data.type === 'quiz' || data.type === 'answer') {
            if (dataChannel.readyState === 'open') {
              const ack = JSON.stringify({
                type: 'ack',
                messageId: data.messageId,
                timestamp: Date.now()
              });
              dataChannel.send(ack);
            }
          }
        }
      } catch (err) {
        console.error('[Creator] Error processing message:', err);
      }
    };
  
    // Set up ICE candidate handling after we have the sessionId
    creatorPeer.onicecandidate = async (event) => {
      if (event.candidate) {
        console.log("[Creator] New ICE candidate");
        try {
          const response = await fetch('/api/signal', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: sessionId,
              ice: event.candidate.toJSON(),
              role: 'creator'
            })
          });
          if (!response.ok) {
            console.error("[Creator] Failed to send ICE candidate");
          }
        } catch (err) {
          console.error("[Creator] Error sending ICE candidate:", err);
        }
      } else {
        console.log("[Creator] ICE gathering complete");
      }
    };
  
    // Enhanced connection state monitoring
    let connectionMonitorInterval: NodeJS.Timeout | null = null;
    let lastStateChange = Date.now();
    const MAX_STATE_DURATION = 15000; // 15 seconds
    const CONNECTION_CHECK_INTERVAL = 3000; // Check every 3 seconds instead of 2

    const monitorConnection = () => {
      if (connectionMonitorInterval) clearInterval(connectionMonitorInterval);
      
      connectionMonitorInterval = setInterval(() => {
        const currentTime = Date.now();
        const stateDuration = currentTime - lastStateChange;

        // Log connection state periodically for debugging
        console.log(`[Creator] Connection monitoring - state: ${creatorPeer.connectionState}, ice state: ${creatorPeer.iceConnectionState}, data channel: ${dataChannel.readyState}, duration: ${stateDuration}ms`);

        if (creatorPeer.connectionState === 'disconnected' && stateDuration > MAX_STATE_DURATION) {
          console.log("[Creator] Connection stuck in disconnected state, attempting recovery");
          handleConnectionRecovery();
        }

        // Check for long-lasting connecting state
        if (creatorPeer.connectionState === 'connecting' && stateDuration > 20000) {
          console.log("[Creator] Connection stuck in connecting state, attempting recovery");
          handleConnectionRecovery();
        }

        // Check ICE connection state
        if (creatorPeer.iceConnectionState === 'disconnected' || creatorPeer.iceConnectionState === 'failed') {
          console.log("[Creator] ICE connection issues detected, attempting recovery");
          handleConnectionRecovery();
        }
        
        // Check if data channel is closed but peer is still connected
        if (dataChannel.readyState === 'closed' && creatorPeer.connectionState === 'connected') {
          console.log("[Creator] Data channel closed while peer connected, attempting to reopen");
          try {
            const newDataChannel = creatorPeer.createDataChannel("quizChannel", {
              ordered: true,
              maxRetransmits: 30,
              protocol: 'quiz',
              negotiated: true,
              id: 0
            });
            // Copy event handlers from the old channel
            newDataChannel.onopen = dataChannel.onopen;
            newDataChannel.onclose = dataChannel.onclose;
            newDataChannel.onerror = dataChannel.onerror;
            newDataChannel.onmessage = dataChannel.onmessage;
            
            // Replace the data channel reference
            Object.assign(dataChannel, newDataChannel);
            console.log("[Creator] Data channel reopened");
          } catch (err) {
            console.error("[Creator] Failed to reopen data channel:", err);
          }
        }
      }, CONNECTION_CHECK_INTERVAL);
    };

    const handleConnectionRecovery = async () => {
      console.log("[Creator] Starting connection recovery process");
      
      // Add a random delay before starting recovery to avoid stampede
      const recoveryDelay = Math.floor(Math.random() * 2000) + 1000; // 1-3 seconds
      await new Promise(resolve => setTimeout(resolve, recoveryDelay));
      
      if (creatorPeer.connectionState === 'failed' || 
          creatorPeer.connectionState === 'disconnected' ||
          creatorPeer.iceConnectionState === 'failed') {
        try {
          console.log("[Creator] Creating recovery offer with ICE restart");
          // First try ICE restart
          const offer = await creatorPeer.createOffer({ 
            iceRestart: true,
            offerToReceiveAudio: false,
            offerToReceiveVideo: false
          });
          
          console.log("[Creator] Setting local description for recovery");
          await creatorPeer.setLocalDescription(offer);
          
          // Send the new offer to signaling server
          console.log("[Creator] Sending recovery offer to signaling server");
          const response = await fetch('/api/signal', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              sessionId,
              offer: creatorPeer.localDescription,
              role: 'creator',
              recovery: true
            })
          });
          
          if (!response.ok) {
            throw new Error('Failed to send recovery offer');
          }
          
          console.log("[Creator] Recovery offer sent successfully");
          lastStateChange = Date.now();
          
          // Try to reopen the data channel after recovery if it's closed
          if (dataChannel.readyState === 'closed') {
            try {
              console.log("[Creator] Attempting to recreate data channel after recovery");
              const newDataChannel = creatorPeer.createDataChannel("quizChannel", {
                ordered: true,
                maxRetransmits: 30,
                protocol: 'quiz',
                negotiated: true,
                id: 0
              });
              
              // Copy event handlers from the old channel
              newDataChannel.onopen = dataChannel.onopen;
              newDataChannel.onclose = dataChannel.onclose;
              newDataChannel.onerror = dataChannel.onerror;
              newDataChannel.onmessage = dataChannel.onmessage;
              
              // Replace the data channel reference
              Object.assign(dataChannel, newDataChannel);
            } catch (channelErr) {
              console.error("[Creator] Failed to recreate data channel after recovery:", channelErr);
            }
          }
        } catch (err) {
          console.error("[Creator] Recovery attempt failed:", err);
        }
      }
    };

    // Update connection state handler
    creatorPeer.onconnectionstatechange = () => {
      const state = creatorPeer.connectionState;
      const prevState = lastStateChange > 0 ? state : 'new'; // Track the previous state for better logging
      console.log(`[Creator] Connection state changed: ${prevState} -> ${state}`);
      lastStateChange = Date.now();

      if (state === 'connected') {
        console.log("[Creator] Connection established successfully");
        
        // When connection is established, verify that the data channel is open
        if (dataChannel.readyState !== 'open') {
          console.log(`[Creator] Data channel not open (${dataChannel.readyState}), attempting to reopen`);
          try {
            const newDataChannel = creatorPeer.createDataChannel("quizChannel", {
              ordered: true,
              maxRetransmits: 30,
              protocol: 'quiz',
              negotiated: true,
              id: 0
            });
            // Copy event handlers
            newDataChannel.onopen = dataChannel.onopen;
            newDataChannel.onclose = dataChannel.onclose;
            newDataChannel.onerror = dataChannel.onerror;
            newDataChannel.onmessage = dataChannel.onmessage;
            
            // Replace reference
            Object.assign(dataChannel, newDataChannel);
          } catch (err) {
            console.error("[Creator] Failed to recreate data channel:", err);
          }
        }
      } else if (state === 'disconnected') {
        console.log("[Creator] Connection disconnected, monitoring for recovery");
        monitorConnection();
        
        // Start a timer to check if we successfully recover
        setTimeout(() => {
          if (creatorPeer.connectionState === 'disconnected') {
            console.log("[Creator] Still disconnected after timeout, attempting active recovery");
            handleConnectionRecovery();
          }
        }, 5000); // Wait 5 seconds before trying active recovery
      } else if (state === 'failed') {
        console.log("[Creator] Connection failed, attempting immediate recovery");
        handleConnectionRecovery();
      } else if (state === 'connecting') {
        console.log("[Creator] Connection is being established");
        // Set a timeout to ensure we don't get stuck in connecting state
        setTimeout(() => {
          if (creatorPeer.connectionState === 'connecting') {
            console.log("[Creator] Connection stuck in connecting state, attempting recovery");
            handleConnectionRecovery();
          }
        }, 20000); // Wait 20 seconds in connecting state before recovery
      }
    };

    // Start monitoring connection quality
    monitorConnectionQuality(creatorPeer);

    // Return object with additional methods for reliable messaging
    return { 
      creatorPeer, 
      dataChannel, 
      sessionId,
      sendReliableMessage: (data: any) => {
        const type = data.type || 'unknown';
        console.log(`[Creator] Preparing to send message of type: ${type}`);
        
        // Only use reliable messaging for answers and quizzes
        const needsReliability = type === 'answer' || type === 'quiz';
        
        if (!needsReliability) {
          // Send directly without queuing or message ID for heartbeats, acks, etc.
          if (dataChannel.readyState === 'open') {
            const messageString = JSON.stringify(data);
            dataChannel.send(messageString);
            return null;
          }
          return null;
        }
        
        // For messages needing reliability (answers and quizzes)
        let messageId = data.messageId;
        if (!messageId) {
          messageId = Math.random().toString(36).substring(2);
        }
        
        const message = {
          ...data,
          messageId
        };
        
        console.log(`[Creator] Sending reliable message with ID: ${messageId}, type: ${type}`);
        const messageString = JSON.stringify(message);
        return messageQueue.enqueue(messageString);
      }
    };
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
  
export async function joinConnection(sessionId: string, participantId: string) {
  // Create persistent set to track processed message IDs at the connection level
  const processedMessageIds = new Set<string>();
  
  console.log("[Participant] Joining session:", sessionId);
  
  const participantPeer = new RTCPeerConnection(getICEConfiguration());
  
  // Start monitoring connection quality
  monitorConnectionQuality(participantPeer);
  
  // Enhanced connection monitoring for participant
  let connectionMonitorInterval: NodeJS.Timeout | null = null;
  let lastStateChange = Date.now();
  const MAX_STATE_DURATION = 15000; // 15 seconds

  const monitorConnection = () => {
    if (connectionMonitorInterval) clearInterval(connectionMonitorInterval);
    
    connectionMonitorInterval = setInterval(() => {
      const currentTime = Date.now();
      const stateDuration = currentTime - lastStateChange;

      if (participantPeer.connectionState === 'disconnected' && stateDuration > MAX_STATE_DURATION) {
        console.log("[Participant] Connection stuck in disconnected state, attempting recovery");
        handleConnectionRecovery();
      }

      // Check ICE connection state
      if (participantPeer.iceConnectionState === 'disconnected' || participantPeer.iceConnectionState === 'failed') {
        console.log("[Participant] ICE connection issues detected, attempting recovery");
        handleConnectionRecovery();
      }
    }, 2000);
  };

  const handleConnectionRecovery = async () => {
    console.log("[Participant] Starting connection recovery process");
    
    try {
      // Get fresh session info
      const response = await fetch(`/api/signal?session=${sessionId}&participant=${participantId}`);
      if (!response.ok) {
        throw new Error('Failed to get session info during recovery');
      }

      const session = await response.json();
      
      if (session.offer) {
        // Set remote description with latest offer
        await participantPeer.setRemoteDescription(session.offer);
        
        // Create new answer
        const answer = await participantPeer.createAnswer();
        await participantPeer.setLocalDescription(answer);
        
        // Send new answer to signaling server
        const updateResponse = await fetch('/api/signal', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            participantId,
            answer,
            role: 'participant'
          })
        });
        
        if (!updateResponse.ok) {
          throw new Error('Failed to send recovery answer');
        }
        
        console.log("[Participant] Recovery answer sent successfully");
        lastStateChange = Date.now();
      }
    } catch (err) {
      console.error("[Participant] Recovery attempt failed:", err);
    }
  };

  // Start connection monitoring
  monitorConnection();

  // Get session info from signaling server
  const response = await fetch(`/api/signal?session=${sessionId}&participant=${participantId}`);
  if (!response.ok) {
    throw new Error('Failed to get session info');
  }

  const session = await response.json();
  
  if (!session.offer) {
    throw new Error('No offer found for this session');
  }

  console.log("[Participant] Got session info with offer");

  let receiveChannel: RTCDataChannel | null = null;
  let messageQueue: MessageQueue | null = null;

  // Create a more robust promise for data channel establishment
  const channelPromise = new Promise<RTCDataChannel>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Data channel establishment timeout'));
    }, 30000);

    try {
      // First set the remote description before creating data channel
      console.log("[Participant] Setting remote description");
      participantPeer.setRemoteDescription(session.offer)
        .then(() => {
          console.log("[Participant] Remote description set successfully");
          
          // After setting remote description, create the data channel
          try {
            // Create the data channel with the same ID as the creator
            const channel = participantPeer.createDataChannel("quizChannel", {
              ordered: true,
              maxRetransmits: 30,
              protocol: 'quiz',
              negotiated: true,
              id: 0
            });

            console.log("[Participant] Created data channel with ID:", channel.id);
            
            channel.onopen = () => {
              console.log("[Participant] Data Channel is open!");
              
              // Initialize message queue when channel opens
              if (!messageQueue) {
                messageQueue = new MessageQueue(channel);
              }
              
              clearTimeout(timeout);
              resolve(channel);
            };

            channel.onclose = () => {
              console.log("[Participant] Data Channel closed!");
              handleConnectionRecovery();
            };

            channel.onerror = (event) => {
              console.error("[Participant] Data Channel error:", event);
              handleConnectionRecovery();
            };
            
            // ... rest of the channel setup ...

            // Save reference to the channel
            receiveChannel = channel;

            // If the channel is already open (rare but possible), resolve immediately
            if (channel.readyState === 'open') {
              console.log("[Participant] Data Channel already open!");
              
              // Initialize message queue
              if (!messageQueue) {
                messageQueue = new MessageQueue(channel);
              }
              
              clearTimeout(timeout);
              resolve(channel);
            }

            // Also listen for ondatachannel event as fallback
            participantPeer.ondatachannel = (event) => {
              console.log("[Participant] Received data channel from ondatachannel event");
              const backupChannel = event.channel;

              backupChannel.onopen = () => {
                console.log("[Participant] Backup Data Channel is open!");
                
                // Initialize message queue for backup channel
                if (!messageQueue && (receiveChannel === null || receiveChannel.readyState !== 'open')) {
                  messageQueue = new MessageQueue(backupChannel);
                }
                
                if (!receiveChannel || receiveChannel.readyState !== 'open') {
                  clearTimeout(timeout);
                  resolve(backupChannel);
                }
              };

              backupChannel.onclose = () => {
                console.log("[Participant] Backup Data Channel closed!");
                handleConnectionRecovery();
              };

              backupChannel.onerror = (event) => {
                console.error("[Participant] Backup Data Channel error:", event);
                handleConnectionRecovery();
              };

              backupChannel.onmessage = (event) => {
                try {
                  const data = JSON.parse(event.data);
                  
                  // Handle ACK messages silently
                  if (data.type === 'ack' && data.messageId) {
                    if (messageQueue) {
                      messageQueue.acknowledge(data.messageId);
                    }
                    return; // Don't process ACKs further
                  }
                  
                  // For non-ACK messages that have a messageId, send ACK only if not processed before
                  if (data.messageId && !processedMessageIds.has(data.messageId)) {
                    processedMessageIds.add(data.messageId);
                    
                    // Only send ACK for messages that require reliability
                    if (data.type === 'quiz' || data.type === 'answer') {
                      if (backupChannel.readyState === 'open') {
                        const ack = JSON.stringify({
                          type: 'ack',
                          messageId: data.messageId,
                          timestamp: Date.now()
                        });
                        backupChannel.send(ack);
                      }
                    }
                  }
                } catch (err) {
                  console.error('[Participant] Error processing message on backup channel:', err);
                }
              };
            };
          } catch (err) {
            console.error("[Participant] Failed to create data channel:", err);
            reject(err);
          }
        })
        .catch(err => {
          console.error("[Participant] Error in connection setup:", err);
          reject(err);
        });
    } catch (err) {
      console.error("[Participant] Error in connection initialization:", err);
      clearTimeout(timeout);
      reject(err);
    }
  });

  // Set up ICE candidate handling
  participantPeer.onicecandidate = async (event) => {
    if (event.candidate) {
      console.log("[Participant] New ICE candidate");
      try {
        const response = await fetch(`/api/signal`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            participantId,
            ice: event.candidate.toJSON(),
            role: 'participant'
          })
        });
        if (!response.ok) {
          console.error("[Participant] Failed to send ICE candidate");
        }
      } catch (err) {
        console.error("[Participant] Error sending ICE candidate:", err);
      }
    } else {
      console.log("[Participant] ICE gathering complete");
    }
  };

  // Create and set local description (answer)
  console.log("[Participant] Creating answer");
  const answer = await participantPeer.createAnswer();
  await participantPeer.setLocalDescription(answer);
  console.log("[Participant] Local description (answer) set");

  // Add existing ICE candidates after setting descriptions
  if (session.creatorIce?.length) {
    console.log("[Participant] Adding existing ICE candidates:", session.creatorIce.length);
    await Promise.all(session.creatorIce.map((ice: RTCIceCandidateInit) => {
      return participantPeer.addIceCandidate(new RTCIceCandidate(ice))
        .catch(err => console.error('[Participant] Failed to add ICE candidate:', err));
    }));
  }

  // Send answer to signaling server
  console.log("[Participant] Sending answer to signaling server");
  const answerResponse = await fetch('/api/signal', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      sessionId,
      participantId,
      answer: participantPeer.localDescription 
    })
  });

  if (!answerResponse.ok) {
    throw new Error('Failed to send answer to signaling server');
  }
  console.log("[Participant] Answer sent successfully");

  // Wait for data channel establishment
  const channel = await channelPromise;
  
  return {
    participantPeer,
    getChannel: () => channel,
    sendReliableMessage: (data: any) => {
      if (!messageQueue) {
        console.error('[Participant] Cannot send message, no message queue available');
        return null;
      }
      
      let type = 'unknown';
      try {
        if (typeof data === 'object' && data !== null && 'type' in data) {
          type = data.type;
        }
      } catch (e) {
        // Ignore any errors in type extraction
      }
      
      console.log(`[Participant] Preparing to send message of type: ${type}`);
      
      // Only use reliable messaging for answers and quizzes
      const needsReliability = type === 'answer' || type === 'quiz';
      
      if (!needsReliability) {
        // Send directly without queuing or message ID for heartbeats, acks, etc.
        if (channel.readyState === 'open') {
          const messageString = JSON.stringify(data);
          channel.send(messageString);
          return null;
        }
        return null;
      }
      
      // For messages needing reliability (answers and quizzes)
      let messageId = data.messageId;
      if (!messageId) {
        messageId = Math.random().toString(36).substring(2);
      }
      
      // Add message ID for tracking
      const message = {
        ...data,
        messageId
      };
      
      console.log(`[Participant] Sending reliable message with ID: ${messageId}, type: ${type}`);
      return messageQueue.enqueue(JSON.stringify(message));
    }
  };
}
  
export function addCreatorIceCandidate(
  participantPeer: RTCPeerConnection,
  candidate: RTCIceCandidate
) {
  participantPeer.addIceCandidate(candidate);
}
  
// Poll for updates (new ICE candidates)
export async function pollUpdates(
  sessionId: string,
  role: 'creator' | 'participant',
  peer: RTCPeerConnection,
  participantId?: string
) {
  let processedIceCandidates = new Set<string>();
  let pendingIceCandidates: RTCIceCandidateInit[] = [];
  let hostAddress = typeof window !== 'undefined' ? window.location.host : 'localhost:3000';
  
  // Try to get the host address for better cross-device communication
  try {
    hostAddress = await getHostAddress();
  } catch (err) {
    console.warn("Could not get host address for API calls, using default");
  }

  // Track consecutive failures to implement backoff
  let consecutiveFailures = 0;
  const MAX_FAILURES = 5;
  let pollingInterval = 1000; // Start with 1 second
  const MAX_POLLING_INTERVAL = 5000; // Max 5 seconds
  const TOTAL_POLLING_DURATION = 10 * 60 * 1000; // Poll for 10 minutes
  const startTime = Date.now();

  // Use let instead of const for interval so we can reassign it
  let interval = setInterval(pollFunction, pollingInterval);

  // Define the polling function that will be called at each interval
  async function pollFunction() {
    // Check if we've been polling for too long
    const elapsedTime = Date.now() - startTime;
    
    // Only stop polling if peer is not connected and we've reached maximum duration
    if (elapsedTime > TOTAL_POLLING_DURATION && peer.connectionState !== 'connected') {
      console.log(`[${role}] Maximum polling duration (${TOTAL_POLLING_DURATION/60000} minutes) reached for session ${sessionId}, stopping automatic polling.`);
      console.log(`[${role}] User may need to manually reconnect or create new session.`);
      clearInterval(interval);
      return;
    }
    
    try {
      // If we have too many consecutive failures, increase polling interval
      if (consecutiveFailures >= MAX_FAILURES) {
        pollingInterval = Math.min(pollingInterval * 1.5, MAX_POLLING_INTERVAL);
        console.log(`[${role}] Too many consecutive failures, increasing polling interval to ${pollingInterval}ms`);
        clearInterval(interval);
        interval = setInterval(pollFunction, pollingInterval);
        consecutiveFailures = Math.floor(MAX_FAILURES / 2); // Reduce to half to allow recovery
        return; // Skip this iteration after rescheduling
      }

      let url: URL;
      
      if (role === 'participant') {
        // Participants need the full URL with host for cross-device communication
        // Always use the full URL with host address for participants
        url = new URL(`${hostAddress}/api/signal`);
      } else {
        // Creators can use relative URLs since they're on the same device as the server
        url = new URL('/api/signal', window.location.origin);
      }
      
      url.searchParams.set('session', sessionId);
      if (participantId) {
        url.searchParams.set('participant', participantId);
      }

      console.log(`[${role}] Polling updates from: ${url.toString()}`);
      const response = await fetch(url.toString());
      
      if (!response.ok) {
        // Get more information about the failed response
        const statusText = response.statusText;
        const status = response.status;
        let responseText = '';
        
        try {
          // Try to get response text for more context
          responseText = await response.text();
        } catch (textError) {
          // If we can't get the response text, just continue
          console.warn(`[${role}] Could not read response text:`, textError);
        }
        
        // For 404 errors when participant trying to connect, retry with increasing backoff 
        // but don't stop polling - session might be created later
        if (status === 404 && role === 'participant') {
          consecutiveFailures++;
          console.log(`[${role}] Session not found (${status}), waiting for creator to establish session...`);
          return;
        }
        
        throw new Error(
          `Failed to poll updates: ${status} ${statusText}. ` + 
          `URL: ${url.toString()}. ` +
          (responseText ? `Response: ${responseText}` : 'No response text available.')
        );
      }

      // We got a successful response, reset failure counter
      consecutiveFailures = 0;

      const session = await response.json();

      // If the session contains no data, it's pending participant connection
      if (role === 'creator' && session.participants && Object.keys(session.participants).length === 0) {
        console.log(`[${role}] No participants have joined yet, continuing to poll...`);
      }

      if (role === 'creator' && session.participants) {
        // Handle new participants and their ICE candidates
        for (const [pid, participant] of Object.entries<{
          answer?: RTCSessionDescriptionInit;
          participantIce: RTCIceCandidateInit[];
        }>(session.participants)) {
          // First handle the answer if we haven't yet
          if (participant.answer && !peer.remoteDescription) {
            try {
              console.log("[Creator] Setting remote description from answer");
              await peer.setRemoteDescription(participant.answer);
              
              // After setting remote description, add any pending ICE candidates
              for (const ice of pendingIceCandidates) {
                try {
                  await peer.addIceCandidate(new RTCIceCandidate(ice));
                  processedIceCandidates.add(JSON.stringify(ice));
                } catch (err) {
                  console.error('[Creator] Failed to add pending ICE candidate:', err);
                }
              }
              pendingIceCandidates = [];
            } catch (err) {
              console.error('[Creator] Failed to set remote description:', err);
              continue;
            }
          }

          // Then handle ICE candidates
          if (participant.participantIce?.length) {
            for (const ice of participant.participantIce) {
              const iceString = JSON.stringify(ice);
              if (!processedIceCandidates.has(iceString)) {
                if (!peer.remoteDescription) {
                  // Store ICE candidate for later if remote description isn't set
                  pendingIceCandidates.push(ice);
                  processedIceCandidates.add(iceString);
                } else {
                  try {
                    await peer.addIceCandidate(new RTCIceCandidate(ice));
                    processedIceCandidates.add(iceString);
                  } catch (err) {
                    console.error('[Creator] Failed to add ICE candidate:', err);
                  }
                }
              }
            }
          }
        }
      } else if (role === 'participant' && session.creatorIce?.length) {
        for (const ice of session.creatorIce) {
          const iceString = JSON.stringify(ice);
          if (!processedIceCandidates.has(iceString)) {
            if (!peer.remoteDescription) {
              // Store ICE candidate for later if remote description isn't set
              pendingIceCandidates.push(ice);
              processedIceCandidates.add(iceString);
            } else {
              try {
                await peer.addIceCandidate(new RTCIceCandidate(ice));
                processedIceCandidates.add(iceString);
              } catch (err) {
                console.error('[Participant] Failed to add ICE candidate:', err);
              }
            }
          }
        }
      }

      // Check if connection is established - if so, we can reduce polling frequency but not stop it
      if (peer.connectionState === 'connected' && peer.iceConnectionState === 'connected') {
        console.log(`[${role}] Connection fully established, reducing polling frequency`);
        // Reduce polling but don't stop completely to handle any reconnection needs
        clearInterval(interval);
        pollingInterval = 5000; // Longer interval when connected
        interval = setInterval(pollFunction, pollingInterval);
      }
    } catch (error) {
      // Increment failure counter
      consecutiveFailures++;
      
      console.error(`[${role}] Error polling updates (failure #${consecutiveFailures}):`, error);
      
      // Add retry logic when connection issues occur
      if (peer.connectionState !== 'connected') {
        console.log(`[${role}] Connection not established yet, continuing to poll...`);
      }
    }
  }

  // Start by calling the function immediately
  pollFunction();

  return () => clearInterval(interval);
}