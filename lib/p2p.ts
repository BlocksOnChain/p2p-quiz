// Add this at the top of the file, below existing imports
import { getHostAddress } from './utils';

// Message queue for reliable message delivery
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
  private acknowledgedMessages: Set<string> = new Set(); // Track messages that have been acknowledged
  // NEW: Track messages by their original messageId (not queue ID)
  private messageIdToQueueId: Map<string, string> = new Map();
  
  constructor(channel: RTCDataChannel) {
    this.channel = channel;
    this.startRetryTimer();
  }
  
  // Enqueue a message for sending
  enqueue(data: string, maxAttempts = 5): string {
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
      console.log(`[MessageQueue] Message ${id} was already acknowledged, removing from queue`);
      this.queue.delete(id);
      return true;
    }
    
    // Check if channel is open
    if (this.channel.readyState !== 'open') {
      console.log(`[MessageQueue] Channel not open, keeping message ${id} in queue`);
      return false;
    }
    
    // Check if message is in queue
    const message = this.queue.get(id);
    if (!message) return false;
    
    // Check if message is already pending acknowledgment
    if (this.pendingMessages.has(id)) {
      console.log(`[MessageQueue] Message ${id} is already pending ACK, not resending yet`);
      return false;
    }
    
    // Only attempt to send if we haven't reached max attempts
    if (message.attempts >= message.maxAttempts) {
      console.error(`[MessageQueue] Max attempts (${message.maxAttempts}) reached for message ${id}, dropping`);
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
        console.log(`[MessageQueue] Sending ${parsedMessage.type || 'unknown'} message, ID: ${id}, attempt ${message.attempts}/${message.maxAttempts}`);
        
        // Check if it's an answer message (for debugging)
        if (parsedMessage.type === 'answer') {
          console.log(`[MessageQueue] This is an ANSWER message, messageId: ${parsedMessage.messageId}, attempt ${message.attempts}/${message.maxAttempts}`);
        }
        
        // Special case for ACK messages - don't wait for acknowledgment
        if (parsedMessage.type === 'ack') {
          console.log(`[MessageQueue] This is an ACK message, not waiting for ACK of ACK`);
          // Remove from queue immediately since ACKs don't need acknowledgment themselves
          this.pendingMessages.delete(id);
          this.queue.delete(id);
          // Still send the message though
        }
      } catch (err) {
        // If parsing fails, just log the normal message
        console.error('[MessageQueue] Failed to parse message for logging:', err);
      }
      
      // Send the message
      this.channel.send(message.data);
      console.log(`[MessageQueue] Sent message ${id}, attempt ${message.attempts}/${message.maxAttempts}`);
      
      // Set a timeout to consider message as failed if no ACK received
      setTimeout(() => {
        if (this.pendingMessages.has(id) && !this.acknowledgedMessages.has(id)) {
          console.log(`[MessageQueue] No ACK for message ${id} after waiting, will retry on next timer`);
          this.pendingMessages.delete(id);
        }
      }, 3000); // Wait 3 seconds for ACK
      
      return true;
    } catch (err) {
      console.error(`[MessageQueue] Error sending message ${id}:`, err);
      this.pendingMessages.delete(id);
      return false;
    }
  }
  
  // Mark a message as successfully delivered (called when ACK received)
  acknowledge(id: string): void {
    console.log(`[MessageQueue] Acknowledging message ${id}`);
    
    // Check if this is a messageId (from the message) rather than a queue ID
    const queueId = this.messageIdToQueueId.get(id) || id;
    
    if (queueId !== id) {
      console.log(`[MessageQueue] Mapped messageId ${id} to queue ID ${queueId}`);
    }
    
    // If it's not in our queue, still add to the acknowledged set
    if (!this.queue.has(queueId) && !this.pendingMessages.has(queueId)) {
      console.log(`[MessageQueue] Message ${queueId} is not in our queue, might be already acknowledged`);
      this.acknowledgedMessages.add(id); // Add the original messageId to the acknowledged set
      this.acknowledgedMessages.add(queueId); // Also add the queue ID to be safe
      return;
    }
    
    this.pendingMessages.delete(queueId);
    this.queue.delete(queueId);
    
    // Add both the original messageId and the queue ID to the acknowledged set
    this.acknowledgedMessages.add(id);
    this.acknowledgedMessages.add(queueId);
    
    // Keep the acknowledged set from growing too large
    if (this.acknowledgedMessages.size > 100) {
      // Remove oldest entries if we have too many
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
        console.log(`[MessageQueue] Retry timer: ${this.queue.size} messages in queue`);
        
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
            console.error(`[MessageQueue] Max attempts reached for message ${id}, dropping`);
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

export async function createConnection() {
    const creatorPeer = new RTCPeerConnection({
      iceServers: [
        { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] },
        // Use Google's free TURN server
        {
          urls: "turn:us-turn1.3cx.com:443?transport=tcp",
          username: "test",
          credential: "test"
        },
        {
          urls: "turn:us-turn2.3cx.com:80?transport=tcp",
          username: "test",
          credential: "test"
        }
      ],
      iceTransportPolicy: 'all',
      iceCandidatePoolSize: 10
    });
  
    console.log("[Creator] Creating RTCPeerConnection");
  
    // Create data channel with more reliable settings
    const dataChannel = creatorPeer.createDataChannel("quizChannel", {
      ordered: true,
      maxRetransmits: 10,
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
  
    dataChannel.onmessage = (event) => {
      console.log("[Creator] Received message:", event.data);
      
      try {
        // Check if it's an ACK message
        const data = JSON.parse(event.data);
        
        // NEW: Log the complete message type for debugging
        console.log(`[Creator] Parsed message type: ${data.type}, messageId: ${data.messageId || 'none'}`);
        
        if (data.type === 'ack' && data.messageId) {
          // Find message queue and acknowledge
          const messageQueue = messageQueues.get(sessionId);
          if (messageQueue) {
            console.log(`[Creator] Received ACK for message ${data.messageId}`);
            messageQueue.acknowledge(data.messageId);
          } else {
            console.error(`[Creator] No message queue found for session ${sessionId}`);
          }
          return; // Don't process ACKs further
        }
        
        // Try to send ACK immediately for any message with an ID
        if (data.messageId) {
          try {
            console.log(`[Creator] Sending immediate ACK for message ${data.messageId}`);
            
            // FIXED: Send ACK directly without using the message queue at all
            if (dataChannel.readyState === 'open') {
              const ack = JSON.stringify({
                type: 'ack',
                messageId: data.messageId,
                timestamp: Date.now()
              });
              
              // Send directly - no enqueuing
              dataChannel.send(ack);
              console.log(`[Creator] Sent direct ACK for message ${data.messageId}`);
            }
          } catch (ackErr) {
            console.error('[Creator] Failed to send ACK:', ackErr);
          }
        }
      } catch (err) {
        console.error('[Creator] Error processing message:', err);
        // Not JSON or not in ACK format, continue with normal processing
      }
    };
  
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
  
    // Set up connection state handlers
    creatorPeer.onconnectionstatechange = () => {
      console.log("[Creator] Connection state:", creatorPeer.connectionState);
      if (creatorPeer.connectionState === 'failed') {
        console.error("[Creator] Connection failed, attempting ICE restart");
        // Try ICE restart
        creatorPeer.restartIce();
        
        // If ICE restart doesn't work after 5 seconds, try full reconnection
        setTimeout(async () => {
          if (creatorPeer.connectionState === 'failed') {
            console.log("[Creator] ICE restart failed, attempting full reconnection");
            try {
              const offer = await creatorPeer.createOffer({ iceRestart: true });
              await creatorPeer.setLocalDescription(offer);
              
              // Send the new offer to signaling server
              const response = await fetch('/api/signal', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                  sessionId,
                  offer: creatorPeer.localDescription,
                  role: 'creator'
                })
              });
              
              if (!response.ok) {
                throw new Error('Failed to send new offer to signaling server');
              }
            } catch (err) {
              console.error("[Creator] Failed to perform full reconnection:", err);
            }
          }
        }, 5000);
      } else if (creatorPeer.connectionState === 'disconnected') {
        console.log("[Creator] Connection disconnected, waiting for reconnection");
        // Add a timeout to detect if disconnection persists
        setTimeout(() => {
          if (creatorPeer.connectionState === 'disconnected') {
            console.log("[Creator] Connection still disconnected, attempting ICE restart");
            creatorPeer.restartIce();
          }
        }, 3000);
      }
    };
  
    creatorPeer.oniceconnectionstatechange = () => {
      console.log("[Creator] ICE Connection state:", creatorPeer.iceConnectionState);
      // Handle specific ICE connection states
      if (creatorPeer.iceConnectionState === 'failed') {
        console.log("[Creator] ICE Connection failed, gathering new candidates");
        creatorPeer.restartIce();
      } else if (creatorPeer.iceConnectionState === 'disconnected') {
        // Start a timer to check if we need to restart ICE
        setTimeout(() => {
          if (creatorPeer.iceConnectionState === 'disconnected') {
            console.log("[Creator] ICE still disconnected, restarting");
            creatorPeer.restartIce();
          }
        }, 3000);
      }
    };

    creatorPeer.onnegotiationneeded = async () => {
      console.log("[Creator] Negotiation needed");
      try {
        const offer = await creatorPeer.createOffer();
        await creatorPeer.setLocalDescription(offer);
        
        // Send the new offer to signaling server
        const response = await fetch('/api/signal', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            sessionId,
            offer: creatorPeer.localDescription,
            role: 'creator'
          })
        });
        
        if (!response.ok) {
          throw new Error('Failed to send negotiation offer to signaling server');
        }
      } catch (err) {
        console.error("[Creator] Failed to handle negotiation:", err);
      }
    };

    // Create a message queue for this channel
    const messageQueues = new Map<string, MessageQueue>();
    const messageQueue = new MessageQueue(dataChannel);
    messageQueues.set(sessionId, messageQueue);

    // Return object with additional methods for reliable messaging
    return { 
      creatorPeer, 
      dataChannel, 
      sessionId,
      // Add a method to send messages reliably
      sendReliableMessage: (data: any) => {
        // IMPROVED: More detailed logging
        const type = data.type || 'unknown';
        console.log(`[Creator] Preparing to send reliable message of type: ${type}`);
        
        // FIXED: Ensure a consistent messageId is used
        let messageId = data.messageId;
        if (!messageId) {
          messageId = Math.random().toString(36).substring(2);
        }
        
        // Create a new message with the messageId
        const message = {
          ...data,
          messageId
        };
        
        console.log(`[Creator] Sending message with ID: ${messageId}, type: ${type}`);
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
  console.log("[Participant] Joining session:", sessionId);
  
  // Get the host address dynamically
  const hostAddress = await getHostAddress();
  
  // Get session info from signaling server
  const response = await fetch(`http://${hostAddress}/api/signal?session=${sessionId}&participant=${participantId}`);
  if (!response.ok) {
    throw new Error('Failed to get session info');
  }

  const session = await response.json();
  
  if (!session.offer) {
    throw new Error('No offer found for this session');
  }

  console.log("[Participant] Got session info with offer");

  // Create new RTCPeerConnection with fresh ICE servers
  const participantPeer = new RTCPeerConnection({
    iceServers: [
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] },
      // Use Google's free TURN server
      {
        urls: "turn:us-turn1.3cx.com:443?transport=tcp",
        username: "test",
        credential: "test"
      },
      {
        urls: "turn:us-turn2.3cx.com:80?transport=tcp",
        username: "test",
        credential: "test"
      }
    ],
    iceTransportPolicy: 'all',
    iceCandidatePoolSize: 10
  });

  let receiveChannel: RTCDataChannel | null = null;
  
  // Add a messageQueue for participant
  let messageQueue: MessageQueue | null = null;

  // Create a more robust promise for data channel establishment
  const channelPromise = new Promise<RTCDataChannel>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Data channel establishment timeout'));
    }, 30000); // Increased timeout to 30 seconds

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
              maxRetransmits: 10,
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
            };

            channel.onerror = (event) => {
              console.error("[Participant] Data Channel error:", event);
              // Don't reject here as we might still get a channel via ondatachannel
            };
            
            channel.onmessage = (event) => {
              console.log("[Participant] Received message:", event.data);
              
              try {
                // Check if it's an ACK message
                const data = JSON.parse(event.data);
                
                // NEW: Log the complete message type for debugging
                console.log(`[Participant] Parsed message type: ${data.type}, messageId: ${data.messageId || 'none'}`);
                
                if (data.type === 'ack' && data.messageId) {
                  // FIXED: More robust acknowledgment handling
                  console.log(`[Participant] Received ACK for message ${data.messageId}`);
                  
                  // Acknowledge the message
                  if (messageQueue) {
                    messageQueue.acknowledge(data.messageId);
                    console.log(`[Participant] Successfully acknowledged message ${data.messageId}`);
                  } else {
                    console.error('[Participant] No message queue available for acknowledgment');
                  }
                  return; // Don't process ACKs further
                }
                
                // Try to send ACK immediately for any message with an ID
                if (data.messageId) {
                  try {
                    console.log(`[Participant] Sending immediate ACK for message ${data.messageId}`);
                    
                    // FIXED: Send ACK directly without using the message queue at all
                    if (channel.readyState === 'open') {
                      const ack = JSON.stringify({
                        type: 'ack',
                        messageId: data.messageId,
                        timestamp: Date.now()
                      });
                      
                      // Send directly - no enqueuing
                      channel.send(ack);
                      console.log(`[Participant] Sent direct ACK for message ${data.messageId}`);
                    }
                  } catch (ackErr) {
                    console.error('[Participant] Failed to send ACK:', ackErr);
                  }
                }
              } catch (err) {
                console.error('[Participant] Error processing message:', err);
                // Not JSON or not in ACK format, continue with normal processing
              }
            };

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
          } catch (err) {
            console.error("[Participant] Failed to create data channel:", err);
            // Continue - we'll try with ondatachannel as backup
          }
          
          // Create and set local description (answer)
          console.log("[Participant] Creating answer");
          return participantPeer.createAnswer();
        })
        .then(answer => {
          return participantPeer.setLocalDescription(answer);
        })
        .then(() => {
          console.log("[Participant] Local description (answer) set");
          
          // Add existing ICE candidates after setting descriptions
          if (session.creatorIce?.length) {
            console.log("[Participant] Adding existing ICE candidates:", session.creatorIce.length);
            return Promise.all(session.creatorIce.map((ice: RTCIceCandidateInit) => {
              return participantPeer.addIceCandidate(new RTCIceCandidate(ice))
                .catch(err => console.error('[Participant] Failed to add ICE candidate:', err));
            }));
          }
        })
        .then(() => {
          // Send answer to signaling server
          console.log("[Participant] Sending answer to signaling server");
          return fetch(`http://${hostAddress}/api/signal`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              sessionId,
              participantId,
              answer: participantPeer.localDescription 
            })
          });
        })
        .then(response => {
          if (!response.ok) {
            throw new Error('Failed to send answer to signaling server');
          }
          console.log("[Participant] Answer sent successfully");
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
      };

      backupChannel.onerror = (event) => {
        console.error("[Participant] Backup Data Channel error:", event);
      };

      backupChannel.onmessage = (event) => {
        console.log("[Participant] Received message on backup channel:", event.data);
        
        try {
          // Check if it's an ACK message
          const data = JSON.parse(event.data);
          
          // NEW: Log the complete message type for debugging
          console.log(`[Participant] Backup channel parsed message type: ${data.type}, messageId: ${data.messageId || 'none'}`);
          
          if (data.type === 'ack' && data.messageId) {
            // FIXED: More robust acknowledgment handling
            console.log(`[Participant] Received ACK for message ${data.messageId} on backup channel`);
            
            // Acknowledge the message
            if (messageQueue) {
              messageQueue.acknowledge(data.messageId);
              console.log(`[Participant] Successfully acknowledged message ${data.messageId} from backup channel`);
            } else {
              console.error('[Participant] No message queue available for acknowledgment on backup channel');
            }
            return; // Don't process ACKs further
          }
          
          // Try to send ACK immediately for any message with an ID
          if (data.messageId) {
            try {
              console.log(`[Participant] Sending immediate ACK for message ${data.messageId} from backup channel`);
              
              // FIXED: Send ACK directly without using the message queue at all
              if (backupChannel.readyState === 'open') {
                const ack = JSON.stringify({
                  type: 'ack',
                  messageId: data.messageId,
                  timestamp: Date.now()
                });
                
                // Send directly - no enqueuing
                backupChannel.send(ack);
                console.log(`[Participant] Sent direct ACK for message ${data.messageId} from backup channel`);
              }
            } catch (ackErr) {
              console.error('[Participant] Failed to send ACK from backup channel:', ackErr);
            }
          }
        } catch (err) {
          console.error('[Participant] Error processing message on backup channel:', err);
          // Not JSON or not in ACK format, continue with normal processing
        }
      };
      
      // If the backup channel is already open, resolve immediately
      if (backupChannel.readyState === 'open') {
        console.log("[Participant] Backup Data Channel already open!");
        
        // Initialize message queue
        if (!messageQueue && (receiveChannel === null || receiveChannel.readyState !== 'open')) {
          messageQueue = new MessageQueue(backupChannel);
        }
        
        if (!receiveChannel || receiveChannel.readyState !== 'open') {
          clearTimeout(timeout);
          resolve(backupChannel);
        }
      }
    };
  });

  // Set up ICE candidate handling
  participantPeer.onicecandidate = async (event) => {
    if (event.candidate) {
      console.log("[Participant] New ICE candidate");
      try {
        const response = await fetch(`http://${hostAddress}/api/signal`, {
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

  // Set up connection state handlers with more detailed logging
  participantPeer.onconnectionstatechange = () => {
    console.log("[Participant] Connection state changed to:", participantPeer.connectionState);
    if (participantPeer.connectionState === 'failed') {
      console.error("[Participant] Connection failed, attempting ICE restart");
      participantPeer.restartIce();
      
      // After 5 seconds, if still failed, try complete renegotiation
      setTimeout(() => {
        if (participantPeer.connectionState === 'failed' || 
            participantPeer.connectionState === 'disconnected') {
          console.log("[Participant] Connection still broken after ICE restart, suggesting reconnect");
        }
      }, 5000);
    }
  };

  participantPeer.oniceconnectionstatechange = () => {
    console.log("[Participant] ICE Connection state changed to:", participantPeer.iceConnectionState);
    if (participantPeer.iceConnectionState === 'failed') {
      console.log("[Participant] ICE Connection failed, attempting restart");
      participantPeer.restartIce();
    } else if (participantPeer.iceConnectionState === 'disconnected') {
      // Start a timer to check if we need to restart ICE
      setTimeout(() => {
        if (participantPeer.iceConnectionState === 'disconnected') {
          console.log("[Participant] ICE still disconnected, restarting");
          participantPeer.restartIce();
        }
      }, 3000);
    }
  };

  participantPeer.onnegotiationneeded = async () => {
    console.log("[Participant] Negotiation needed");
    try {
      // Create a new answer
      const answer = await participantPeer.createAnswer();
      await participantPeer.setLocalDescription(answer);
      
      // Send the new answer to the server
      const response = await fetch(`http://${hostAddress}/api/signal`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          participantId,
          answer: participantPeer.localDescription
        })
      });
      
      if (!response.ok) {
        throw new Error('Failed to send renegotiation answer');
      }
    } catch (err) {
      console.error("[Participant] Failed to handle negotiation:", err);
    }
  };

  // Wait for data channel with a more informative timeout message
  console.log("[Participant] Waiting for data channel to be established");
  try {
    const channel = await channelPromise;
    console.log("[Participant] Data channel successfully established");
    
    // Ensure message queue is created
    if (!messageQueue) {
      messageQueue = new MessageQueue(channel);
    }
    
    return {
      participantPeer,
      getChannel: () => channel,
      // Add method to send messages reliably
      sendReliableMessage: (data: any) => {
        if (!messageQueue) {
          console.error('[Participant] Cannot send message, no message queue available');
          return null;
        }
        
        let type = 'unknown';
        try {
          // Try to extract the message type for better logging
          if (typeof data === 'object' && data !== null && 'type' in data) {
            type = data.type;
          }
        } catch (e) {
          // Ignore any errors in type extraction
        }
        
        console.log(`[Participant] Preparing to send reliable message of type: ${type}`);
        
        // FIXED: Ensure a consistent messageId is used
        let messageId = data.messageId;
        if (!messageId) {
          messageId = Math.random().toString(36).substring(2);
        }
        
        // Add message ID for tracking
        const message = {
          ...data,
          messageId
        };
        
        console.log(`[Participant] Sending message with ID: ${messageId}, type: ${type}`);
        
        // IMPORTANT: If this is an answer message, log it prominently
        if (type === 'answer') {
          console.log(`[Participant] SENDING ANSWER with ID: ${messageId} !!!`);
        }
        
        const messageString = JSON.stringify(message);
        return messageQueue.enqueue(messageString);
      }
    };
  } catch (error) {
    console.error("[Participant] Failed to establish data channel:", error);
    throw error;
  }
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

  // Use let instead of const for interval so we can reassign it
  let interval = setInterval(pollFunction, pollingInterval);

  // Define the polling function that will be called at each interval
  async function pollFunction() {
    try {
      // If we have too many consecutive failures, increase polling interval
      if (consecutiveFailures >= MAX_FAILURES) {
        pollingInterval = Math.min(pollingInterval * 1.5, MAX_POLLING_INTERVAL);
        console.log(`[${role}] Too many consecutive failures, increasing polling interval to ${pollingInterval}ms`);
        clearInterval(interval);
        interval = setInterval(pollFunction, pollingInterval);
        consecutiveFailures = 0; // Reset after adjusting
        return; // Skip this iteration after rescheduling
      }

      let url: URL;
      
      if (role === 'participant') {
        // Participants need the full URL with host for cross-device communication
        // Always use the full URL with host address for participants
        url = new URL(`http://${hostAddress}/api/signal`);
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
        
        throw new Error(
          `Failed to poll updates: ${status} ${statusText}. ` + 
          `URL: ${url.toString()}. ` +
          (responseText ? `Response: ${responseText}` : 'No response text available.')
        );
      }

      // We got a successful response, reset failure counter
      consecutiveFailures = 0;

      const session = await response.json();

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

      // Check if connection is established - if so, we can stop polling
      if (peer.connectionState === 'connected' && peer.iceConnectionState === 'connected') {
        console.log(`[${role}] Connection fully established, stopping polling`);
        clearInterval(interval);
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