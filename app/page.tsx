'use client';

import React, { useState, useRef, useEffect, useCallback, Suspense } from 'react';
import { createConnection, joinConnection, pollUpdates } from '@/lib/p2p';
import { useSearchParams, useRouter } from 'next/navigation';
import { Inter } from 'next/font/google';
import { QRCodeSVG } from 'qrcode.react';
import { getHostAddress } from '@/lib/utils';
import P2PStatus from '@/app/components/p2p-status';

const inter = Inter({ subsets: ['latin'] });

// Minimal type for messages exchanged over data channel.
interface QuizMessage {
  type: 'quiz' | 'answer' | 'info' | 'heartbeat';
  payload: string;
  participantId?: string;
}

interface Quiz {
  id: string;
  question: string;
  correctAnswer: string;
  timestamp: number;
  timeLimit?: number; // in seconds
  points?: number;
}

interface Answer {
  quizId: string;
  participantId: string;
  answer: string;
  timestamp: number;
  timeTaken?: number; // in seconds
  score?: number;
}

// Add new state for managing draft questions
interface DraftQuiz {
  question: string;
  correctAnswer: string;
  timeLimit: number;
  points: number;
}

// Add a StatusBar component to display connection information
const StatusBar = ({ 
  connectionStatus, 
  heartbeatStatus, 
  messageSendingStatus,
  isLoading,
  onReconnect
}: { 
  connectionStatus: string; 
  heartbeatStatus: string; 
  messageSendingStatus: string;
  isLoading: boolean;
  onReconnect: () => void;
}) => {
  return (
    <div className="flex items-center gap-2">
      <div className={`w-3 h-3 rounded-full ${
        connectionStatus === 'connected' 
          ? heartbeatStatus === 'connected' 
            ? 'bg-green-500 animate-pulse' 
            : heartbeatStatus === 'reconnecting' 
              ? 'bg-yellow-500 animate-pulse' 
              : 'bg-red-500 animate-pulse'
          : connectionStatus === 'connecting'
            ? 'bg-blue-500 animate-pulse'
            : 'bg-red-500 animate-pulse'
      }`}></div>
      <span className={`${
        connectionStatus === 'connected' 
          ? heartbeatStatus === 'connected' 
            ? 'text-green-600' 
            : heartbeatStatus === 'reconnecting' 
              ? 'text-yellow-600' 
              : 'text-red-600'
          : connectionStatus === 'connecting'
            ? 'text-blue-600'
            : 'text-red-600'
      } font-semibold`}>
        {connectionStatus === 'connected' 
          ? heartbeatStatus === 'connected' 
            ? 'Connected' 
            : heartbeatStatus === 'reconnecting' 
              ? 'Connection unstable - attempting to reconnect...' 
              : 'Connection unstable'
          : connectionStatus === 'connecting' 
            ? 'Establishing connection...' 
            : 'Disconnected'
        }
        {messageSendingStatus === 'sending' && ' (Sending data...)'}
        {messageSendingStatus === 'failed' && ' (Data send failed)'}
      </span>
      
      {/* Manual reconnect button */}
      {(connectionStatus === 'disconnected' || heartbeatStatus === 'disconnected' || heartbeatStatus === 'reconnecting') && (
        <button 
          onClick={onReconnect}
          disabled={isLoading}
          className="ml-2 px-3 py-1 bg-blue-500 hover:bg-blue-600 text-white text-sm rounded disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
        >
          {isLoading ? (
            <>
              <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Reconnecting...
            </>
          ) : (
            'Reconnect'
          )}
        </button>
      )}
    </div>
  );
};

function HomeContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Get mode and session ID from URL
  const sessionId = searchParams.get('session');
  const initialMode = sessionId ? 'participant' : 'creator';

  const [mode, setMode] = useState<'creator' | 'participant'>(initialMode);
  const [connectionStatus, setConnectionStatus] = useState<string>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // ===================
  // Creator states & logic
  // ===================
  const [quizQuestion, setQuizQuestion] = useState('');
  const [quizAnswer, setQuizAnswer] = useState('');
  const [sentQuizzes, setSentQuizzes] = useState<Quiz[]>([]);
  const [participantAnswers, setParticipantAnswers] = useState<Answer[]>([]);
  const [creatorSessionId, setCreatorSessionId] = useState<string>('');
  const [connectedParticipants, setConnectedParticipants] = useState<Set<string>>(new Set());

  const creatorPeerRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const dataChannelRef = useRef<Map<string, RTCDataChannel>>(new Map());

  // Add new state for quiz settings
  const [timeLimit, setTimeLimit] = useState(60); // default 60 seconds
  const [points, setPoints] = useState(10); // default 10 points
  const [quizTimer, setQuizTimer] = useState<number | null>(null);
  const [scores, setScores] = useState<Map<string, number>>(new Map());

  // Add state for draft questions
  const [draftQuizzes, setDraftQuizzes] = useState<DraftQuiz[]>([]);
  const [isEditing, setIsEditing] = useState(false);

  // Add new state for tracking message delivery status
  const [messageSendingStatus, setMessageSendingStatus] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [heartbeatStatus, setHeartbeatStatus] = useState<'connected' | 'reconnecting' | 'disconnected'>('disconnected');
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastHeartbeatResponseRef = useRef<number>(0);
  const reliableSenderRef = useRef<((data: any) => string | null) | null>(null);

  // Add a new state for host address
  const [hostAddress, setHostAddress] = useState<string>('');
  
  // Add new state for tracking processed message IDs
  const processedMessageIdsRef = useRef<Set<string>>(new Set());
  
  // Fetch the host address when the component mounts
  useEffect(() => {
    async function fetchHostAddress() {
      const address = await getHostAddress();
      setHostAddress(address);
    }
    fetchHostAddress();
  }, []);

  // Function to start heartbeat mechanism
  const startHeartbeat = useCallback((channel: RTCDataChannel, sendReliable?: (data: any) => string | null) => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }
    
    // Store the reliable sender if provided
    if (sendReliable) {
      reliableSenderRef.current = sendReliable;
    }
    
    const MAX_MISSED_HEARTBEATS = 3;
    let missedHeartbeats = 0;
    lastHeartbeatResponseRef.current = Date.now();
    
    // Initial update of heartbeat status based on channel state
    if (channel.readyState === 'open') {
      setHeartbeatStatus('connected');
    } else {
      setHeartbeatStatus('reconnecting');
    }
    
    // Set up message handler for heartbeat responses if it doesn't exist
    const originalOnMessage = channel.onmessage;
    channel.onmessage = function(event) {
      // Call original handler if exists
      if (originalOnMessage) {
        originalOnMessage.call(this, event);
      }
      
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'heartbeat') {
          // Update last heartbeat response timestamp
          lastHeartbeatResponseRef.current = Date.now();
          missedHeartbeats = 0;
          
          // Update heartbeat status
          if (heartbeatStatus !== 'connected') {
            setHeartbeatStatus('connected');
            
            // If the WebRTC connectionState is still disconnected but we're receiving heartbeats,
            // update the connectionStatus to connected as well
            if (connectionStatus !== 'connected') {
              setConnectionStatus('connected');
              console.log('[Heartbeat] Received heartbeat while connection state is not connected, updating UI');
            }
          }
        }
      } catch (err) {
        // Ignore parsing errors for non-JSON messages
      }
    };
    
    heartbeatIntervalRef.current = setInterval(() => {
      // Check if we've received a response recently
      const timeSinceLastResponse = Date.now() - lastHeartbeatResponseRef.current;
      
      // Check data channel state first - no point in trying if it's closed
      if (channel.readyState !== 'open') {
        missedHeartbeats++;
        console.log(`[Heartbeat] Data channel not open (${channel.readyState}), counting as missed heartbeat #${missedHeartbeats}`);
        
        if (missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
          setHeartbeatStatus('disconnected');
          // Only update connection status if we're sure we've lost connection
          if (connectionStatus !== 'disconnected' && missedHeartbeats >= MAX_MISSED_HEARTBEATS + 2) {
            setConnectionStatus('disconnected');
            console.log('[Heartbeat] Multiple heartbeats missed and channel closed, updating UI to disconnected');
          }
        } else {
          setHeartbeatStatus('reconnecting');
        }
        return; // Skip sending if channel is closed
      }
      
      if (timeSinceLastResponse > 8000) { // 8 seconds without response
        missedHeartbeats++;
        console.log(`[Heartbeat] Missed ${missedHeartbeats} heartbeats. Last response: ${timeSinceLastResponse}ms ago`);
        
        if (missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
          // Too many missed heartbeats, mark as disconnected
          setHeartbeatStatus('disconnected');
          
          // Only set connection status to disconnected if WebRTC also reports disconnected
          // AND we've missed several heartbeats (not just the minimum)
          if (missedHeartbeats >= MAX_MISSED_HEARTBEATS + 2 && 
              (channel.readyState !== 'open' || 
              (channel === dataChannelRef.current.get(creatorSessionId) && 
               creatorPeerRef.current.get(creatorSessionId)?.connectionState !== 'connected'))) {
            setConnectionStatus('disconnected');
            console.log('[Heartbeat] Connection appears to be fully disconnected, updating UI');
          }
        } else if (missedHeartbeats >= 1) {
          // At least one missed heartbeat, mark as reconnecting
          setHeartbeatStatus('reconnecting');
          console.log('[Heartbeat] Connection appears unstable, marking as reconnecting');
        }
      } else if (missedHeartbeats > 0) {
        // We've received a recent response, reset missed heartbeats
        console.log('[Heartbeat] Resetting missed heartbeats count, connection appears stable');
        missedHeartbeats = 0;
        setHeartbeatStatus('connected');
        
        // If connection status is disconnected but we're getting heartbeats,
        // update it to connected since the data channel is working
        if (connectionStatus !== 'connected') {
          setConnectionStatus('connected');
        }
      }
      
      // Send new heartbeat
      try {
        if (channel.readyState === 'open') {
          // Always use direct channel send for heartbeats - they don't need reliability guarantees
          // and we want to minimize overhead for this frequent operation
          channel.send(JSON.stringify({
            type: 'heartbeat',
            timestamp: Date.now()
          }));
        } else {
          console.log(`[Heartbeat] Channel not open (state: ${channel.readyState}), skipping heartbeat`);
          missedHeartbeats++;
        }
      } catch (err) {
        console.error('[Heartbeat] Failed to send heartbeat:', err);
        missedHeartbeats++;
      }
    }, 3000);
    
    return () => {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    };
  }, [creatorSessionId, connectionStatus, heartbeatStatus]);

  // Creator: create quiz & WebRTC connection
  const handleCreateQuiz = async () => {
    setError(null);
    setIsLoading(true);
    try {
      const { creatorPeer, dataChannel, sessionId, sendReliableMessage } = await createConnection();
      creatorPeerRef.current.set(sessionId, creatorPeer);
      dataChannelRef.current.set(sessionId, dataChannel);
      setCreatorSessionId(sessionId);
      
      // Store the reliable message sender
      reliableSenderRef.current = sendReliableMessage;

      // Monitor connection state
      creatorPeer.onconnectionstatechange = () => {
        const state = creatorPeer.connectionState;
        console.log("[Creator Frontend] Connection state changed:", state);
        
        // Check data channel state as well for more accurate status
        const channelState = dataChannel.readyState;
        console.log("[Creator Frontend] Data channel state:", channelState);
        
        if (state === 'connected' && channelState === 'open') {
          setConnectionStatus('connected');
          setError(null);
          
          // If we were disconnected but reconnected, reset heartbeat status
          if (heartbeatStatus === 'disconnected') {
            setHeartbeatStatus('connected');
            lastHeartbeatResponseRef.current = Date.now();
          }
          
          // Only update connected participants if we have a valid session ID
          if (typeof sessionId === 'string' && sessionId.length > 0) {
            setConnectedParticipants(prev => new Set(prev).add(sessionId));
          }
        } else if (state === 'connecting') {
          // When in connecting state, update UI to show connecting but don't change to disconnected
          setConnectionStatus('connecting');
          console.log("[Creator Frontend] Connection in connecting state, updating UI");
          
          // Check after a delay if we're still in connecting state
          setTimeout(() => {
            // If both checks pass, and we're still in connecting state after delay, 
            // but data channel is open, consider it as connected
            if (
              creatorPeer.connectionState === 'connecting' && 
              dataChannel.readyState === 'open'
            ) {
              console.log("[Creator Frontend] Connection still in connecting state but data channel is open, treating as connected");
              setConnectionStatus('connected');
              setHeartbeatStatus('connected');
              lastHeartbeatResponseRef.current = Date.now();
            }
          }, 5000);
        } else if (state === 'failed' || state === 'closed') {
          setConnectionStatus('disconnected');
          setHeartbeatStatus('disconnected');
          setError('Connection to participant lost. They may need to reconnect.');
        } else if (state === 'disconnected') {
          // Don't immediately set as disconnected, let the heartbeat mechanism verify
          console.log("[Creator Frontend] Connection in disconnected state, waiting for heartbeat verification");
          setHeartbeatStatus('reconnecting');
          
          // Check if data channel is still open despite the disconnected state
          if (dataChannel.readyState === 'open') {
            console.log("[Creator Frontend] Connection in disconnected state but data channel is open, keeping connection status");
            // Don't change the connection status yet, just update heartbeat
            // This prevents unnecessary reconnection prompts
          } else {
            // If still disconnected after 5 seconds, update the UI
            setTimeout(() => {
              if (creatorPeer.connectionState === 'disconnected' && 
                  dataChannel.readyState !== 'open' &&
                  (Date.now() - lastHeartbeatResponseRef.current > 5000)) {
                setConnectionStatus('disconnected');
                console.log("[Creator Frontend] Connection still disconnected after delay, updating UI");
              } else if (dataChannel.readyState === 'open') {
                // If data channel is open, consider it connected regardless of WebRTC state
                setConnectionStatus('connected');
                console.log("[Creator Frontend] Data channel is open, treating as connected despite disconnected WebRTC state");
              }
            }, 5000); // Reduced from 10 seconds to 5 seconds for better responsiveness
          }
        }
      };

      dataChannel.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          
          // Handle ACK messages silently
          if (parsed.type === 'ack' && parsed.messageId) {
            return; // Don't process ACKs further
          }
          
          // Only send ACK for non-ACK messages with messageId that we haven't processed
          if (parsed.messageId && !processedMessageIdsRef.current.has(parsed.messageId)) {
            processedMessageIdsRef.current.add(parsed.messageId);
            
            // Only send ACK for messages that require reliability
            if (parsed.type === 'quiz' || parsed.type === 'answer') {
              const ack = JSON.stringify({
                type: 'ack',
                messageId: parsed.messageId,
                timestamp: Date.now()
              });
              
              if (dataChannel.readyState === 'open') {
                dataChannel.send(ack);
              }
            }
          }
          
          // Handle heartbeat response
          if (parsed.type === 'heartbeat') {
            lastHeartbeatResponseRef.current = Date.now();
            setHeartbeatStatus('connected');
            
            // If a participant ID is included, mark them as connected
            if (parsed.participantId) {
              setConnectedParticipants(prev => {
                const updated = new Set(prev);
                updated.add(parsed.participantId);
                return updated;
              });
            }
            return;
          }
          
          if (parsed.type === 'answer' && parsed.participantId) {
            const answerData = JSON.parse(parsed.payload);
            console.log("[Creator] Received answer:", answerData);
            
            // Check if we already have this answer (prevent duplicates)
            const isDuplicate = participantAnswers.some(
              a => a.quizId === answerData.quizId && a.participantId === parsed.participantId
            );
            
            if (!isDuplicate) {
              const answer: Answer = {
                quizId: answerData.quizId,
                participantId: parsed.participantId,
                answer: answerData.answer,
                timestamp: Date.now(),
                timeTaken: answerData.timeTaken,
                score: answerData.score
              };
              setParticipantAnswers(prev => [...prev, answer]);
            } else {
              console.log("[Creator] Ignoring duplicate answer");
            }
            
            // Update connected participants
            setConnectedParticipants(prev => {
              const updated = new Set(prev);
              if (parsed.participantId) {
                updated.add(parsed.participantId);
              }
              return updated;
            });
          }
        } catch (err) {
          console.error('Error processing message:', err);
        }
      };

      // Start polling for updates
      pollUpdates(sessionId, 'creator', creatorPeer);
      
      // Start heartbeat
      startHeartbeat(dataChannel, sendReliableMessage);
    } catch (err) {
      console.error(err);
      setError('Failed to create quiz session. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // Function to add a new draft quiz
  const handleAddDraftQuiz = () => {
    if (!quizQuestion.trim() || !quizAnswer.trim()) {
      alert('Please enter both question and answer!');
      return;
    }

    setDraftQuizzes(prev => [...prev, {
      question: quizQuestion,
      correctAnswer: quizAnswer,
      timeLimit,
      points
    }]);

    // Clear inputs for next question
    setQuizQuestion('');
    setQuizAnswer('');
  };

  // Function to remove a draft quiz
  const handleRemoveDraftQuiz = (index: number) => {
    setDraftQuizzes(prev => prev.filter((_, i) => i !== index));
  };

  // Function to update quiz sending logic to handle multiple questions
  const handleSendQuiz = () => {
    if (!dataChannelRef.current.size || ![...dataChannelRef.current.values()].every(dc => dc.readyState === 'open')) {
      alert('Not all connections are ready yet!');
      return;
    }

    // Check if we have any questions to send
    const questionsToSend = draftQuizzes.length > 0 ? draftQuizzes : 
      (quizQuestion.trim() && quizAnswer.trim() ? [{
        question: quizQuestion,
        correctAnswer: quizAnswer,
        timeLimit,
        points
      }] : []);

    if (questionsToSend.length === 0) {
      alert('Please add at least one question!');
      return;
    }

    try {
      setMessageSendingStatus('sending');
      
      // Keep track of sent message IDs for logging
      const sentMessageIds: string[] = [];
      
      // Send each quiz
      questionsToSend.forEach(draft => {
        const quizId = Math.random().toString(36).substring(2);
        
        // Check if quiz with this ID already exists
        if (sentQuizzes.some(q => q.id === quizId)) {
          console.log(`Quiz with ID ${quizId} already exists, generating new ID`);
          return; // Skip this iteration and try again with new ID
        }
        
        const newQuiz: Quiz = {
          id: quizId,
          question: draft.question,
          correctAnswer: draft.correctAnswer,
          timestamp: Date.now(),
          timeLimit: draft.timeLimit,
          points: draft.points
        };

        const message: QuizMessage = {
          type: 'quiz',
          payload: JSON.stringify(newQuiz)
        };

        // Send to all connected participants using reliable messaging if available
        if (reliableSenderRef.current) {
          const messageId = reliableSenderRef.current(message);
          if (messageId) {
            sentMessageIds.push(messageId);
            console.log(`Sent quiz ${quizId} with message ID ${messageId}`);
          }
        } else {
          // Fallback to regular send
          dataChannelRef.current.forEach(channel => {
            if (channel.readyState === 'open') {
              channel.send(JSON.stringify(message));
            }
          });
        }

        // Update local state with the new quiz
        setSentQuizzes(prev => [...prev, newQuiz]);
      });

      // Clear draft questions and inputs
      setDraftQuizzes([]);
      setQuizQuestion('');
      setQuizAnswer('');
      
      setMessageSendingStatus('sent');
      setTimeout(() => setMessageSendingStatus('idle'), 2000);
      
      console.log(`Quizzes sent successfully with message IDs: ${sentMessageIds.join(', ')}`);
      alert('Quizzes sent successfully to all participants!');
    } catch (err) {
      console.error('Error sending quizzes:', err);
      setMessageSendingStatus('failed');
      alert('Failed to send quizzes to some participants');
    }
  };

  // ===================
  // Participant states & logic
  // ===================
  const [receivedQuizzes, setReceivedQuizzes] = useState<Quiz[]>([]);
  const [currentQuizId, setCurrentQuizId] = useState<string | null>(null);
  const [myAnswers, setMyAnswers] = useState<Map<string, string>>(new Map());
  const [participantId] = useState(() => Math.random().toString(36).substring(2));
  // Store the original session ID to maintain connection across reconnects
  const originalSessionIdRef = useRef<string | null>(null);

  const participantPeerRef = useRef<RTCPeerConnection | null>(null);
  const participantChannelRef = useRef<RTCDataChannel | null>(null);

  // Join quiz when session ID is present
  useEffect(() => {
    if (sessionId && mode === 'participant') {
      // Store the original session ID
      if (!originalSessionIdRef.current) {
        originalSessionIdRef.current = sessionId;
      }
      handleJoinQuiz(sessionId);
    }
  }, [sessionId, mode]);

  // Participant: join the quiz
  const handleJoinQuiz = async (sid: string) => {
    setError(null);
    setIsLoading(true);
    
    // Use the original session ID if we have one
    const sessionToUse = originalSessionIdRef.current || sid;
    
    // Store this as the original session if we don't have one yet
    if (!originalSessionIdRef.current) {
      originalSessionIdRef.current = sessionToUse;
    }
    
    console.log(`[Participant] Joining/Reconnecting to session: ${sessionToUse} with participant ID: ${participantId}`);
    
    // Clear any existing state to ensure fresh connection
    if (participantPeerRef.current) {
      try {
        participantPeerRef.current.close();
      } catch (err) {
        console.log("Error closing existing peer connection:", err);
      }
      participantPeerRef.current = null;
    }
    
    if (participantChannelRef.current) {
      try {
        participantChannelRef.current.close();
      } catch (err) {
        console.log("Error closing existing data channel:", err);
      }
      participantChannelRef.current = null;
    }
    
    // Reset connection states
    setConnectionStatus('connecting');
    setHeartbeatStatus('disconnected');
    
    try {
      // Use the stored session ID and participant ID for consistent reconnection
      const { participantPeer, getChannel, sendReliableMessage } = await joinConnection(sessionToUse, participantId);
      participantPeerRef.current = participantPeer;
      
      // Store reliable sender
      reliableSenderRef.current = sendReliableMessage;

      // Monitor connection state with more detailed logging
      participantPeer.onconnectionstatechange = () => {
        const state = participantPeer.connectionState;
        console.log("[Participant Frontend] Connection state changed:", state);
        
        // Get the data channel from our ref
        const channel = participantChannelRef.current;
        const channelState = channel ? channel.readyState : 'closed';
        console.log("[Participant Frontend] Data channel state:", channelState);
        
        if (state === 'connected') {
          setConnectionStatus('connected');
          setHeartbeatStatus('connected');
          console.log("[Participant Frontend] Successfully connected to creator");
          // Clear any existing error on successful connection
          setError(null);
          lastHeartbeatResponseRef.current = Date.now();
        } else if (state === 'connecting') {
          // When in connecting state, update UI to show connecting but don't mark as disconnected
          setConnectionStatus('connecting');
          console.log("[Participant Frontend] Connection in connecting state, updating UI");
          
          // Check after a delay if data channel is open despite still in connecting state
          setTimeout(() => {
            if (channel && channel.readyState === 'open') {
              console.log("[Participant Frontend] Data channel is open while in connecting state, treating as connected");
              setConnectionStatus('connected');
              setHeartbeatStatus('connected');
              lastHeartbeatResponseRef.current = Date.now();
            }
          }, 5000);
        } else if (state === 'failed' || state === 'closed') {
          setConnectionStatus('disconnected');
          setHeartbeatStatus('disconnected');
          setError('Connection lost. Please try reconnecting.');
        } else if (state === 'disconnected') {
          // Check if data channel is still open despite the disconnected state
          if (channel && channel.readyState === 'open') {
            console.log("[Participant Frontend] Connection in disconnected state but data channel is open, keeping connection status");
            setHeartbeatStatus('reconnecting');
            // Don't change the connection status yet, just update heartbeat status
          } else {
            setHeartbeatStatus('disconnected');
            
            // Use a shorter timeout for UI responsiveness
            setTimeout(() => {
              // Only set as disconnected if still in that state and no heartbeats received
              if (participantPeer.connectionState === 'disconnected' && 
                  (!channel || channel.readyState !== 'open') &&
                  (Date.now() - lastHeartbeatResponseRef.current > 5000)) {
                setConnectionStatus('disconnected');
                setError('Connection to creator lost. Trying to reconnect...');
              } else if (channel && channel.readyState === 'open') {
                // If data channel is open, consider it connected regardless of WebRTC state
                setConnectionStatus('connected');
                setHeartbeatStatus('connected');
              }
            }, 5000);
          }
        }
      };

      // Check if the data channel is available immediately
      try {
        const channel = getChannel();
        if (channel) {
          console.log("[Participant Frontend] Data channel available immediately");
          setupDataChannel(channel);
          
          // Start heartbeat mechanism
          startHeartbeat(channel, sendReliableMessage);
        } else {
          console.log("[Participant Frontend] Waiting for data channel...");
          // Setup data channel after connection
          let retries = 0;
          const maxRetries = 20;
          const interval = setInterval(() => {
            try {
              const newChannel = getChannel();
              if (newChannel) {
                console.log("[Participant Frontend] Data channel obtained after retry");
                clearInterval(interval);
                setupDataChannel(newChannel);
                
                // Start heartbeat mechanism
                startHeartbeat(newChannel, sendReliableMessage);
              } else if (retries++ >= maxRetries) {
                clearInterval(interval);
                setError('Failed to establish data channel. Please try reconnecting.');
                console.error("[Participant Frontend] Failed to get data channel after max retries");
              }
            } catch (err) {
              console.error("[Participant Frontend] Error getting channel during retry:", err);
              if (retries++ >= maxRetries) {
                clearInterval(interval);
                setError('Failed to establish data channel. Please try reconnecting.');
              }
            }
          }, 500);
        }
      } catch (err) {
        console.error("[Participant Frontend] Error getting initial data channel:", err);
        // Continue anyway as the channel might become available during polling
      }

      // Start polling for updates
      pollUpdates(sessionToUse, 'participant', participantPeer, participantId);
    } catch (err) {
      console.error("[Participant Frontend] Error joining quiz:", err);
      setError('Failed to join quiz session. The session may be invalid or expired.');
    } finally {
      setIsLoading(false);
    }
  };

  // Helper function to setup data channel
  const setupDataChannel = (channel: RTCDataChannel) => {
    participantChannelRef.current = channel;
    
    console.log("[Participant Frontend] Setting up data channel:", channel.readyState);
    
    // If the channel is already open, update status immediately
    if (channel.readyState === 'open') {
      console.log("[Participant Frontend] Data channel already open");
      setConnectionStatus('connected');
    }
    
    channel.onopen = () => {
      console.log("[Participant Frontend] Data channel opened");
      setConnectionStatus('connected');
      // Clear any error messages when channel successfully opens
      setError(null);
    };

    channel.onclose = () => {
      console.log("[Participant Frontend] Data channel closed");
      // Only set to disconnected if peer is also not connected
      if (!participantPeerRef.current || 
          participantPeerRef.current.connectionState !== 'connected') {
        setConnectionStatus('disconnected');
      }
    };

    channel.onerror = (error) => {
      console.error("[Participant Frontend] Data channel error:", error);
      setError('Data channel error occurred. Please try refreshing the page.');
    };

    channel.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        
        // Handle ACK messages silently
        if (parsed.type === 'ack' && parsed.messageId) {
          return; // Don't process ACKs further
        }
        
        // Only send ACK for non-ACK messages with messageId that we haven't processed
        if (parsed.messageId && !processedMessageIdsRef.current.has(parsed.messageId)) {
          processedMessageIdsRef.current.add(parsed.messageId);
          
          // Only send ACK for messages that require reliability
          if (parsed.type === 'quiz' || parsed.type === 'answer') {
            const ack = JSON.stringify({
              type: 'ack',
              messageId: parsed.messageId,
              timestamp: Date.now()
            });
            
            if (channel.readyState === 'open') {
              channel.send(ack);
            }
          }
        }
        
        // Handle heartbeat messages
        if (parsed.type === 'heartbeat') {
          // Update last heartbeat received time
          lastHeartbeatResponseRef.current = Date.now();
          setHeartbeatStatus('connected');
          
          // Reset the connection status if it was previously disconnected
          if (connectionStatus !== 'connected' && channel.readyState === 'open') {
            console.log('[Heartbeat] Reconnected via heartbeat response');
            setConnectionStatus('connected');
          }
          
          // Send heartbeat response back immediately
          try {
            // Send heartbeat response directly (no need for reliable messaging)
            channel.send(JSON.stringify({
              type: 'heartbeat',
              timestamp: Date.now(),
              isResponse: true // Mark as a response to avoid ping-pong
            }));
          } catch (err) {
            console.error('[Heartbeat] Failed to send heartbeat response:', err);
          }
          return; // Skip further processing for heartbeats
        }
        
        if (parsed.type === 'quiz') {
          const quiz: Quiz = JSON.parse(parsed.payload);
          setReceivedQuizzes(prev => {
            // Only add if not already present
            if (!prev.find(q => q.id === quiz.id)) {
              return [...prev, quiz];
            }
            return prev;
          });
          // Set as current quiz if none selected
          setCurrentQuizId(current => current || quiz.id);
        }
      } catch (err) {
        console.error("[Participant Frontend] Failed to parse message:", err);
      }
    };
  };

  // Add timer functionality for participants
  useEffect(() => {
    if (mode === 'participant' && currentQuizId) {
      const quiz = receivedQuizzes.find(q => q.id === currentQuizId);
      if (!quiz || myAnswers.has(quiz.id)) return;

      const startTime = Date.now();
      const timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (quiz.timeLimit && elapsed >= quiz.timeLimit) {
          clearInterval(timer);
          handleTimeUp(quiz.id);
        } else {
          setQuizTimer(quiz.timeLimit ? quiz.timeLimit - elapsed : null);
        }
      }, 1000);

      return () => {
        clearInterval(timer);
        setQuizTimer(null);
      };
    }
  }, [currentQuizId, mode, myAnswers, receivedQuizzes]);

  // Handle time up for a quiz
  const handleTimeUp = (quizId: string) => {
    if (!myAnswers.has(quizId)) {
      handleSendAnswer(quizId, true);
    }
  };

  // Update answer handling to use reliable messaging
  const handleSendAnswer = (quizId: string, isTimeUp: boolean = false) => {
    if (!participantChannelRef.current || participantChannelRef.current.readyState !== 'open') {
      alert('Connection not ready yet!');
      return;
    }

    // Check if we've already submitted an answer and it's in the scores map
    if (scores.has(quizId)) {
      console.log(`Answer for quiz ${quizId} already submitted, ignoring duplicate submission`);
      return;
    }

    const answer = myAnswers.get(quizId) || '';
    if (!isTimeUp && !answer.trim()) {
      alert('Please enter an answer!');
      return;
    }

    const quiz = receivedQuizzes.find(q => q.id === quizId);
    if (!quiz) return;

    const timeTaken = Math.floor((Date.now() - quiz.timestamp) / 1000);
    const isCorrect = answer.toLowerCase().trim() === quiz.correctAnswer.toLowerCase().trim();
    const score = isCorrect ? 
      Math.max(0, quiz.points || 0) * (quiz.timeLimit ? Math.max(0, (quiz.timeLimit - timeTaken) / quiz.timeLimit) : 1) 
      : 0;

    const msg: QuizMessage = {
      type: 'answer',
      participantId,
      payload: JSON.stringify({
        quizId,
        answer,
        timeTaken,
        score
      })
    };

    setMessageSendingStatus('sending');
    
    try {
      // Use reliable messaging if available
      let messageId = null;
      if (reliableSenderRef.current) {
        messageId = reliableSenderRef.current(msg);
      } else {
        participantChannelRef.current.send(JSON.stringify(msg));
      }
      
      // Immediately record this score to prevent duplicate submissions
      setScores(prev => new Map(prev).set(quizId, score));
      
      // Store the message ID to prevent duplicate submissions
      if (messageId) {
        console.log(`Sent answer for quiz ${quizId} with message ID ${messageId}`);
      }
      
      setMessageSendingStatus('sent');
      setTimeout(() => setMessageSendingStatus('idle'), 2000);
      
    } catch (err) {
      console.error('Error sending answer:', err);
      setMessageSendingStatus('failed');
      if (!isTimeUp) {
        alert('Failed to send answer');
      }
    }
  };

  // Get current quiz
  const currentQuiz = receivedQuizzes.find(q => q.id === currentQuizId);

  // Update the creator mode UI
  const renderCreatorUI = () => (
    <div className="space-y-8">
      <div className="space-y-5">
        <div>
          <label className="block text-base font-semibold text-gray-800 mb-2">
            Quiz Question
          </label>
          <input
            type="text"
            className="w-full px-4 py-3 border-2 border-indigo-300 rounded-lg shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all text-gray-900 placeholder:text-gray-400"
            value={quizQuestion}
            onChange={(e) => setQuizQuestion(e.target.value)}
            placeholder="Enter your question..."
          />
        </div>
        <div>
          <label className="block text-base font-semibold text-gray-800 mb-2">
            Correct Answer
          </label>
          <input
            type="text"
            className="w-full px-4 py-3 border-2 border-indigo-300 rounded-lg shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all text-gray-900 placeholder:text-gray-400"
            value={quizAnswer}
            onChange={(e) => setQuizAnswer(e.target.value)}
            placeholder="Enter the correct answer..."
          />
        </div>
        
        <div className="space-y-4 border-t-2 border-indigo-100 pt-5 mt-5">
          <h4 className="text-base font-semibold text-gray-800">Quiz Settings</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Time Limit (seconds)
              </label>
              <input
                type="number"
                min="0"
                className="w-full px-4 py-3 border-2 border-indigo-300 rounded-lg shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all text-gray-900"
                value={timeLimit}
                onChange={(e) => setTimeLimit(Math.max(0, parseInt(e.target.value) || 0))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Points
              </label>
              <input
                type="number"
                min="0"
                className="w-full px-4 py-3 border-2 border-indigo-300 rounded-lg shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all text-gray-900"
                value={points}
                onChange={(e) => setPoints(Math.max(0, parseInt(e.target.value) || 0))}
              />
            </div>
          </div>
        </div>
        
        {!creatorSessionId ? (
          <button
            onClick={handleCreateQuiz}
            className="w-full px-6 py-4 text-white bg-indigo-600 rounded-lg shadow-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 transition-all font-semibold text-base"
            disabled={isLoading}
          >
            {isLoading ? (
              <span className="flex items-center justify-center">
                <span className="inline-block animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-white mr-3"></span>
                Creating Quiz Session...
              </span>
            ) : (
              'Create Quiz Session'
            )}
          </button>
        ) : (
          <div className="space-y-6">
            <div className="p-6 bg-indigo-50 rounded-xl shadow-sm border border-indigo-200">
              <p className="text-base font-semibold text-indigo-800 mb-4">Share this link with participants:</p>
              
              <div className="flex flex-col md:flex-row md:items-start gap-5">
                {/* Link input and copy button */}
                <div className="flex-1">
                  <div className="flex gap-2">
                    <input
                      readOnly
                      className="flex-1 px-4 py-3 bg-white border-2 border-indigo-300 rounded-lg shadow-sm text-indigo-900 font-medium"
                      value={hostAddress ? `${hostAddress}/?session=${creatorSessionId}` : 'Loading link...'}
                    />
                    <button
                      onClick={() => {
                        if (hostAddress) {
                          navigator.clipboard.writeText(
                            `${hostAddress}/?session=${creatorSessionId}`
                          );
                          alert('Link copied!');
                        }
                      }}
                      className="px-5 py-3 text-indigo-700 bg-white border-2 border-indigo-600 rounded-lg shadow-sm hover:bg-indigo-50 transition-colors font-medium"
                      disabled={!hostAddress}
                    >
                      Copy
                    </button>
                  </div>
                  
                  {/* Connected users indicator */}
                  <div className="mt-4 flex items-center">
                    <span className="text-sm font-medium text-indigo-700 mr-2">Connected users:</span>
                    <span className="px-3 py-1 text-sm font-medium rounded-full bg-green-100 text-green-800 shadow-sm">
                      {connectedParticipants.size} {connectedParticipants.size === 1 ? 'user' : 'users'}
                    </span>
                  </div>
                </div>
                
                {/* QR code */}
                <div className="p-5 bg-white border-2 border-indigo-200 rounded-lg shadow-sm text-center">
                  <p className="text-sm font-medium text-indigo-700 mb-3">Or scan QR code:</p>
                  {hostAddress ? (
                    <QRCodeSVG 
                      value={`${hostAddress}/?session=${creatorSessionId}`}
                      size={150}
                      bgColor={"#ffffff"}
                      fgColor={"#4f46e5"}
                      level={"L"}
                      includeMargin={false}
                    />
                  ) : (
                    <div className="flex items-center justify-center w-[150px] h-[150px] bg-gray-100 rounded-lg">
                      <span className="text-gray-400">Loading...</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex gap-4">
              <button
                onClick={handleAddDraftQuiz}
                className="flex-1 px-6 py-4 text-indigo-700 bg-white border-2 border-indigo-600 rounded-lg shadow-md hover:bg-indigo-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 transition-all font-semibold"
                disabled={!quizQuestion.trim() || !quizAnswer.trim() || connectionStatus !== 'connected'}
              >
                Add Question
              </button>
              <button
                onClick={handleSendQuiz}
                className={`flex-1 px-6 py-4 text-white rounded-lg shadow-md focus:outline-none focus:ring-2 focus:ring-offset-2 transition-all font-semibold ${
                  messageSendingStatus === 'sending' ? 'bg-yellow-500' : 
                  messageSendingStatus === 'failed' ? 'bg-red-600' : 
                  'bg-green-600 hover:bg-green-700 focus:ring-green-500'
                }`}
                disabled={connectionStatus !== 'connected' || (!quizQuestion.trim() && draftQuizzes.length === 0) || messageSendingStatus === 'sending'}
              >
                {messageSendingStatus === 'sending' ? (
                  <span className="flex items-center justify-center">
                    <span className="inline-block animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-white mr-3"></span>
                    Sending...
                  </span>
                ) : messageSendingStatus === 'sent' ? (
                  <span className="flex items-center justify-center">
                    <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Sent!
                  </span>
                ) : (
                  `Send ${draftQuizzes.length > 0 ? `${draftQuizzes.length} Questions` : 'Quiz'}`
                )}
              </button>
            </div>

            {renderDraftQuizzes()}

            {renderSentQuizzes()}
          </div>
        )}
      </div>
    </div>
  );

  // Add draft quizzes list
  const renderDraftQuizzes = () => {
    if (draftQuizzes.length === 0) return null;

    return (
      <div className="mt-8 border-t-2 border-indigo-100 pt-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-indigo-900">Draft Questions</h3>
          <span className="text-sm font-medium text-indigo-600 bg-indigo-50 px-3 py-1 rounded-full">{draftQuizzes.length} questions</span>
        </div>
        <div className="space-y-4">
          {draftQuizzes.map((draft, index) => (
            <div key={index} className="p-5 bg-indigo-50 rounded-lg border border-indigo-200 shadow-sm relative group transition-all hover:shadow-md">
              <button
                onClick={() => handleRemoveDraftQuiz(index)}
                className="absolute top-3 right-3 p-1.5 text-gray-400 hover:text-red-500 hover:bg-white rounded-full opacity-0 group-hover:opacity-100 transition-all"
                title="Remove question"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <p className="font-semibold text-gray-900">Question {index + 1}: {draft.question}</p>
              <p className="text-sm font-medium text-gray-700 mt-2">Answer: {draft.correctAnswer}</p>
              <div className="flex items-center gap-4 mt-3">
                <span className="text-xs font-medium text-indigo-700 bg-indigo-100 px-2.5 py-1 rounded-full">
                  Time: {draft.timeLimit}s
                </span>
                <span className="text-xs font-medium text-green-700 bg-green-100 px-2.5 py-1 rounded-full">
                  Points: {draft.points}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // Update the sent quizzes display
  const renderSentQuizzes = () => {
    if (sentQuizzes.length === 0) return null;

    return (
      <div className="mt-10">
        <h3 className="text-xl font-semibold text-indigo-900 mb-5">Sent Quizzes</h3>
        <div className="space-y-8">
          {sentQuizzes.map((quiz, index) => {
            const quizAnswers = participantAnswers.filter(a => a.quizId === quiz.id);
            return (
              <div key={quiz.id} className="p-6 bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-all">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h4 className="font-semibold text-gray-900 text-lg">Question {index + 1}</h4>
                    <p className="text-gray-800 mt-2">{quiz.question}</p>
                    <p className="text-gray-700 font-medium mt-2">Correct Answer: <span className="text-green-600">{quiz.correctAnswer}</span></p>
                  </div>
                  <div className="text-right flex flex-col items-end gap-1.5">
                    <span className="px-3 py-1 text-xs font-medium rounded-full bg-indigo-100 text-indigo-700">
                      Time Limit: {quiz.timeLimit}s
                    </span>
                    <span className="px-3 py-1 text-xs font-medium rounded-full bg-green-100 text-green-700">
                      Points: {quiz.points}
                    </span>
                  </div>
                </div>

                <div className="mt-5 border-t border-gray-200 pt-4">
                  <div className="flex items-center justify-between mb-3">
                    <h5 className="text-sm font-semibold text-gray-800">
                      Responses
                    </h5>
                    <span className="text-xs font-medium bg-gray-100 text-gray-700 px-2.5 py-1 rounded-full">
                      {quizAnswers.length} {quizAnswers.length === 1 ? 'response' : 'responses'}
                    </span>
                  </div>
                  {quizAnswers.length > 0 ? (
                    <div className="space-y-3">
                      {quizAnswers.map(answer => renderQuizWithScore(quiz, answer))}
                    </div>
                  ) : (
                    <div className="p-4 bg-gray-50 rounded-lg text-center">
                      <p className="text-sm text-gray-500 italic">No answers yet</p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Update the quiz display to show scores
  const renderQuizWithScore = (quiz: Quiz, answer: Answer) => (
    <div key={answer.participantId} className="p-4 bg-gray-50 rounded-lg border border-gray-200 hover:shadow-sm transition-all">
      <div className="flex justify-between items-start">
        <div>
          <p className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            Participant {answer.participantId.slice(0, 4)}
            {answer.answer.toLowerCase().trim() === quiz.correctAnswer.toLowerCase().trim() ? 
              <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Correct</span> : 
              <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">Incorrect</span>
            }
          </p>
          <p className="text-sm text-gray-700 mt-2">
            Answer: <span className={answer.answer.toLowerCase().trim() === quiz.correctAnswer.toLowerCase().trim() ? 
              "font-medium text-green-600" : "font-medium text-red-600"}>
              {answer.answer}
            </span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-medium text-gray-900">
            Score: <span className="text-indigo-700">{answer.score?.toFixed(1) || 0}</span> points
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Time taken: {answer.timeTaken}s
          </p>
        </div>
      </div>
    </div>
  );

  // Add timer display for participants
  const renderTimer = () => {
    if (!currentQuiz?.timeLimit || quizTimer === null) return null;
    
    // Calculate percentage for progress bar
    const percentage = Math.min(100, Math.max(0, (quizTimer / currentQuiz.timeLimit) * 100));
    
    return (
      <div className="mb-6">
        <div className="flex justify-between items-center mb-2">
          <span className={`text-base font-medium ${quizTimer < 10 ? 'text-red-600' : 'text-gray-700'}`}>
            Time Remaining: {quizTimer}s
          </span>
          <span className="text-xs font-medium text-gray-500">
            {Math.floor((currentQuiz.timeLimit - quizTimer) / 60)}:{((currentQuiz.timeLimit - quizTimer) % 60).toString().padStart(2, '0')} / 
            {Math.floor(currentQuiz.timeLimit / 60)}:{(currentQuiz.timeLimit % 60).toString().padStart(2, '0')}
          </span>
        </div>
        <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
          <div 
            className={`h-full rounded-full transition-all ease-linear ${
              percentage > 66 ? 'bg-green-500' : 
              percentage > 33 ? 'bg-yellow-500' : 
              'bg-red-500'
            }`}
            style={{ width: `${percentage}%` }}
          ></div>
        </div>
      </div>
    );
  };  

  // Update the participant's quiz display
  const renderCurrentQuiz = () => {
    if (!currentQuiz) return null;
    const score = scores.get(currentQuiz.id);
    
    return (
      <div className="space-y-5">
        {renderTimer()}
        <div className="p-6 bg-white rounded-lg border border-gray-200 shadow-sm">
          <h3 className="text-xl font-semibold text-gray-900 mb-3">
            {currentQuiz.question}
          </h3>
          
          <div className="flex items-center gap-3 mb-4">
            {currentQuiz.timeLimit && (
              <span className="text-xs font-medium bg-indigo-100 text-indigo-700 px-2.5 py-1 rounded-full">
                Time Limit: {currentQuiz.timeLimit}s
              </span>
            )}
            {currentQuiz.points && (
              <span className="text-xs font-medium bg-green-100 text-green-700 px-2.5 py-1 rounded-full">
                Points: {currentQuiz.points}
              </span>
            )}
          </div>
          
          <div className="mt-5">
            <label className="block text-base font-medium text-gray-800 mb-2">
              Your Answer
            </label>
            <input
              type="text"
              className={`w-full px-4 py-3 border-2 ${
                score !== undefined ? 
                  myAnswers.get(currentQuiz.id)?.toLowerCase().trim() === currentQuiz.correctAnswer.toLowerCase().trim() ?
                    'border-green-300 bg-green-50' :
                    'border-red-300 bg-red-50' :
                  'border-indigo-300 bg-white'
              } rounded-lg focus:ring-2 ${
                score !== undefined ?
                  myAnswers.get(currentQuiz.id)?.toLowerCase().trim() === currentQuiz.correctAnswer.toLowerCase().trim() ?
                    'focus:ring-green-500 focus:border-green-500' :
                    'focus:ring-red-500 focus:border-red-500' :
                  'focus:ring-indigo-500 focus:border-indigo-500'
              } transition-all text-gray-900 placeholder:text-gray-400`}
              value={myAnswers.get(currentQuiz.id) || ''}
              onChange={(e) => setMyAnswers(prev => new Map(prev).set(currentQuiz.id, e.target.value))}
              placeholder="Type your answer here..."
              disabled={score !== undefined || connectionStatus !== 'connected'}
            />
            
            {score !== undefined && (
              <div className="mt-4 p-4 rounded-lg bg-gray-50 border border-gray-200">
                <div className="flex justify-between items-center">
                  <p className="text-base font-semibold text-gray-800">
                    Your Score:
                  </p>
                  <p className="text-xl font-bold text-indigo-700">
                    {score.toFixed(1)} points
                  </p>
                </div>
                
                {myAnswers.get(currentQuiz.id)?.toLowerCase().trim() !== currentQuiz.correctAnswer.toLowerCase().trim() && (
                  <div className="mt-3 pt-3 border-t border-gray-200">
                    <p className="text-sm text-gray-700">
                      Correct answer: <span className="font-medium text-green-600">{currentQuiz.correctAnswer}</span>
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        
        <button
          onClick={() => handleSendAnswer(currentQuiz.id)}
          className={`w-full px-6 py-4 text-white rounded-lg shadow-md focus:outline-none focus:ring-2 focus:ring-offset-2 transition-all font-semibold text-base ${
            messageSendingStatus === 'sending' ? 'bg-yellow-500' : 
            messageSendingStatus === 'failed' ? 'bg-red-600' : 
            'bg-indigo-600 hover:bg-indigo-700 focus:ring-indigo-500'
          }`}
          disabled={connectionStatus !== 'connected' || score !== undefined || messageSendingStatus === 'sending'}
        >
          {messageSendingStatus === 'sending' ? (
            <span className="flex items-center justify-center">
              <span className="inline-block animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-white mr-3"></span>
              Sending...
            </span>
          ) : messageSendingStatus === 'sent' ? (
            <span className="flex items-center justify-center">
              <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Answer Sent!
            </span>
          ) : (
            'Submit Answer'
          )}
        </button>
      </div>
    );
  };

  // Add a reconnection function
  const attemptReconnection = useCallback(async () => {
    console.log("[Reconnection] Attempting to reestablish connection");
    setIsLoading(true);
    
    try {
      // Only attempt reconnection if we're in creator mode and have a session ID
      if (mode === 'creator' && creatorSessionId) {
        // Check if the old connection is still usable
        const oldPeer = creatorPeerRef.current.get(creatorSessionId);
        if (oldPeer && 
            (oldPeer.connectionState === 'connected' || oldPeer.iceConnectionState === 'connected')) {
          console.log("[Reconnection] Existing connection still appears valid, skipping reconnection");
          setConnectionStatus('connected');
          setHeartbeatStatus('connected');
          setIsLoading(false);
          return;
        }
        
        // For creator, if we're reconnecting we should use createConnection without expecting a new sessionId
        // This ensures we keep using the same peer and just try to re-establish the connection
        console.log("[Reconnection] Attempting to reconnect creator with existing session ID: ", creatorSessionId);
        
        // Close old connection
        if (oldPeer) {
          try {
            oldPeer.close();
          } catch (err) {
            console.error("[Reconnection] Error closing old peer:", err);
          }
        }
        
        // Create a new connection but preserve the session ID
        const { creatorPeer, dataChannel, sessionId, sendReliableMessage } = await createConnection();
        
        // Check if we got the same session ID back
        if (sessionId !== creatorSessionId) {
          console.warn("[Reconnection] Warning: Reconnected with new session ID. Original:", creatorSessionId, "New:", sessionId);
        }
        
        // Store new connection objects
        creatorPeerRef.current.set(sessionId, creatorPeer);
        dataChannelRef.current.set(sessionId, dataChannel);
        
        // Only update session ID if it's different
        if (sessionId !== creatorSessionId) {
          setCreatorSessionId(sessionId);
        }
        
        // Store the reliable message sender
        reliableSenderRef.current = sendReliableMessage;
        
        // Set up new event handlers - calling setupDataChannel directly
        // Since the function sets up handlers directly on the channel, no need to assign return value
        setupDataChannel(dataChannel);
        
        // Start heartbeat with new channel
        startHeartbeat(dataChannel, sendReliableMessage);
        
        console.log("[Reconnection] Connection reestablished successfully");
        setConnectionStatus('connected');
        setHeartbeatStatus('connected');
        setError(null);
      } else if (mode === 'participant' && sessionId) {
        // For participant, use the original sessionId for reconnection
        const sessionToUse = originalSessionIdRef.current || sessionId;
        console.log("[Reconnection] Participant attempting to rejoin with consistent session ID:", sessionToUse);
        
        // Join the session with existing participant ID to maintain consistency
        const { participantPeer, getChannel, sendReliableMessage } = await joinConnection(
          sessionToUse,
          participantId
        );
        
        // Store the new participant peer
        participantPeerRef.current = participantPeer;
        
        // Get the data channel
        const channel = getChannel();
        participantChannelRef.current = channel;
        
        // Set up data channel - call the function directly rather than using its return value
        setupDataChannel(channel);
        
        // Start heartbeat
        startHeartbeat(channel, sendReliableMessage);
        
        console.log("[Reconnection] Participant reconnected successfully");
        setConnectionStatus('connected');
        setHeartbeatStatus('connected');
      }
    } catch (err: any) { // Type the error as 'any' to access message property
      console.error("[Reconnection] Failed to reconnect:", err);
      setError(`Reconnection failed: ${err?.message || 'Unknown error'}. Please try again or refresh the page.`);
    } finally {
      setIsLoading(false);
    }
  }, [mode, creatorSessionId, sessionId, setupDataChannel, startHeartbeat, participantId]);

  // Add effect to monitor connection status and trigger reconnection
  useEffect(() => {
    // Only attempt automatic reconnection if we've been disconnected for a while
    if (connectionStatus === 'disconnected' || heartbeatStatus === 'disconnected') {
      const timer = setTimeout(() => {
        console.log("[Auto-reconnect] Connection has been down, attempting reconnection");
        attemptReconnection();
      }, 15000); // Wait 15 seconds before attempting reconnection
      
      return () => clearTimeout(timer);
    }
  }, [connectionStatus, heartbeatStatus, attemptReconnection]);

  // Update the return statement to use the P2PStatus component
  return (
    <div className="min-h-screen pb-16">
      {/* Add the P2PStatus component at the top, outside the main content */}
      <P2PStatus
        connectionStatus={connectionStatus}
        heartbeatStatus={heartbeatStatus}
        messageSendingStatus={messageSendingStatus}
        isLoading={isLoading}
        onReconnect={attemptReconnection}
      />
      
      <main className={`min-h-screen p-4 pt-20 md:p-8 md:pt-24 bg-gradient-to-br from-indigo-50 via-indigo-100 to-white ${inter.className}`}>
        <div className="max-w-4xl mx-auto">
          <h1 className="text-3xl md:text-4xl font-bold mb-6 md:mb-8 text-indigo-900 text-center">
            Real-Time P2P Quiz
          </h1>

          {error && (
            <div className="error-message bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative mb-4" role="alert">
              <strong className="font-bold">Error: </strong>
              <span className="block sm:inline">{error}</span>
            </div>
          )}

          <div className="bg-white rounded-xl shadow-lg p-6 md:p-8 mb-8 border border-gray-100">
            <div className="flex flex-col md:flex-row md:items-center gap-4 mb-6 border-b border-gray-100 pb-4">
              <div className="flex-1">
                <h2 className="text-xl font-bold text-indigo-900 mb-1">
                  {mode === 'creator' ? 'Quiz Creator' : 'Quiz Participant'}
                </h2>
              </div>
              {!sessionId && (
                <button
                  onClick={() => setMode(mode === 'creator' ? 'participant' : 'creator')}
                  className="px-5 py-2.5 text-sm font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition-colors"
                >
                  Switch to {mode === 'creator' ? 'Participant' : 'Creator'} Mode
                </button>
              )}
            </div>

            {isLoading ? (
              <div className="text-center py-12">
                <div className="inline-block animate-spin rounded-full h-10 w-10 border-4 border-indigo-300 border-t-indigo-600 mb-4"></div>
                <p className="text-indigo-800 font-medium text-lg">
                  {mode === 'creator' ? 'Creating quiz session...' : 'Joining quiz session...'}
                </p>
                <p className="text-gray-500 mt-2">This may take a few moments</p>
              </div>
            ) : mode === 'creator' ? (
              renderCreatorUI()
            ) : (
              <div className="space-y-6">
                {receivedQuizzes.length > 0 ? (
                  <>
                    {/* Quiz Navigation */}
                    {receivedQuizzes.length > 1 && (
                      <div className="mb-6">
                        <h3 className="text-base font-medium text-gray-700 mb-3">Select a Question:</h3>
                        <div className="flex gap-2 flex-wrap">
                          {receivedQuizzes.map((quiz, index) => {
                            const hasAnswer = scores.has(quiz.id);
                            return (
                              <button
                                key={quiz.id}
                                onClick={() => setCurrentQuizId(quiz.id)}
                                className={`px-4 py-2 rounded-lg transition-all ${currentQuizId === quiz.id
                                  ? 'bg-indigo-600 text-white shadow-md'
                                  : hasAnswer
                                    ? 'bg-green-100 text-green-800 border border-green-300'
                                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-200'
                                }`}
                              >
                                Q{index + 1}
                                {hasAnswer && (
                                  <svg className="w-4 h-4 ml-1 inline-block" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {renderCurrentQuiz()}
                  </>
                ) : connectionStatus === 'connected' ? (
                  <div className="text-center py-16">
                    <div className="w-24 h-24 mx-auto mb-6 rounded-full bg-indigo-100 flex items-center justify-center">
                      <svg className="w-12 h-12 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                      </svg>
                    </div>
                    <h3 className="text-xl font-semibold text-indigo-900 mb-2">Waiting for questions</h3>
                    <p className="text-gray-600">
                      The quiz creator will send questions shortly
                    </p>
                  </div>
                ) : (
                  <div className="text-center py-12">
                    <div className="w-20 h-20 mx-auto rounded-full bg-yellow-100 flex items-center justify-center mb-4">
                      <div className="inline-block animate-pulse rounded-full h-10 w-10 bg-yellow-400"></div>
                    </div>
                    <h3 className="text-xl font-semibold text-gray-800 mb-2">
                      {connectionStatus === 'disconnected' || connectionStatus === 'failed' || connectionStatus === 'closed' 
                        ? 'Connection Lost' 
                        : 'Connecting...'}
                    </h3>
                    <p className="text-gray-600 mb-4">
                      {connectionStatus === 'disconnected' || connectionStatus === 'failed' || connectionStatus === 'closed' 
                        ? 'The connection to the quiz creator was lost'
                        : 'Please wait while we establish a secure connection'}
                    </p>
                    
                    {/* Add reconnect button */}
                    {(connectionStatus === 'disconnected' || connectionStatus === 'failed' || connectionStatus === 'closed') && 
                      sessionId && (
                        <button
                          onClick={() => handleJoinQuiz(sessionId)}
                          className="mt-2 px-6 py-3 bg-indigo-600 text-white rounded-lg shadow-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 transition-all font-medium"
                          disabled={isLoading}
                        >
                          Reconnect
                        </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen p-4 md:p-8 bg-gradient-to-br from-indigo-50 via-indigo-100 to-white flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-10 w-10 border-4 border-indigo-300 border-t-indigo-600 mb-4"></div>
          <p className="text-indigo-800 font-medium text-lg">Loading...</p>
        </div>
      </div>
    }>
      <HomeContent />
    </Suspense>
  );
}