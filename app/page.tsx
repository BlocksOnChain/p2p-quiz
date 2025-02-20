'use client';

import React, { useState, useRef, useEffect } from 'react';
import { createConnection, joinConnection, pollUpdates } from '@/lib/p2p';
import { useSearchParams, useRouter } from 'next/navigation';
import { Inter } from 'next/font/google';

const inter = Inter({ subsets: ['latin'] });

// Minimal type for messages exchanged over data channel.
interface QuizMessage {
  type: 'quiz' | 'answer' | 'info';
  payload: string;
}

export default function HomePage() {
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
  const [creatorSessionId, setCreatorSessionId] = useState<string>('');

  const creatorPeerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);

  // Creator: create quiz & WebRTC connection
  const handleCreateQuiz = async () => {
    setError(null);
    setIsLoading(true);
    try {
      const { creatorPeer, dataChannel, sessionId } = await createConnection();
      creatorPeerRef.current = creatorPeer;
      dataChannelRef.current = dataChannel;
      setCreatorSessionId(sessionId);

      // Monitor connection state
      creatorPeer.onconnectionstatechange = () => {
        const state = creatorPeer.connectionState;
        setConnectionStatus(state);
        if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          setError('Connection lost. Please try refreshing the page.');
        }
      };

      dataChannel.onmessage = (event) => {
        const parsed: QuizMessage = JSON.parse(event.data);
        if (parsed.type === 'answer') {
          alert(`Participant answered: ${parsed.payload}`);
        }
      };

      // Start polling for updates
      pollUpdates(sessionId, 'creator', creatorPeer);
    } catch (err) {
      console.error(err);
      setError('Failed to create quiz session. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // Creator: Send the quiz question
  const handleSendQuiz = () => {
    if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
      alert('Connection not ready yet!');
      return;
    }

    const message: QuizMessage = {
      type: 'quiz',
      payload: JSON.stringify({ question: quizQuestion, correctAnswer: quizAnswer })
    };
    
    try {
      dataChannelRef.current.send(JSON.stringify(message));
      alert('Quiz sent successfully!');
    } catch (err) {
      console.error('Error sending quiz:', err);
      alert('Failed to send quiz');
    }
  };

  // ===================
  // Participant states & logic
  // ===================
  const [receivedQuiz, setReceivedQuiz] = useState<{ question: string; correctAnswer: string } | null>(null);
  const [myAnswer, setMyAnswer] = useState('');

  const participantPeerRef = useRef<RTCPeerConnection | null>(null);
  const participantChannelRef = useRef<RTCDataChannel | null>(null);

  // Join quiz when session ID is present
  useEffect(() => {
    if (sessionId && mode === 'participant') {
      handleJoinQuiz(sessionId);
    }
  }, [sessionId, mode]);

  // Participant: join the quiz
  const handleJoinQuiz = async (sid: string) => {
    setError(null);
    setIsLoading(true);
    try {
      const { participantPeer, getChannel } = await joinConnection(sid);
      participantPeerRef.current = participantPeer;

      // Monitor connection state
      participantPeer.onconnectionstatechange = () => {
        const state = participantPeer.connectionState;
        setConnectionStatus(state);
        if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          setError('Connection lost. Please try refreshing the page.');
        }
      };

      // Start polling for updates
      pollUpdates(sid, 'participant', participantPeer);

      // Setup data channel after connection
      let retries = 0;
      const maxRetries = 10;
      const interval = setInterval(() => {
        const channel = getChannel();
        if (channel) {
          channel.onmessage = (msgEvent) => {
            try {
              const parsed: QuizMessage = JSON.parse(msgEvent.data);
              if (parsed.type === 'quiz') {
                const quizPayload = JSON.parse(parsed.payload);
                setReceivedQuiz(quizPayload);
              }
            } catch (err) {
              console.error('Failed to parse message:', err);
            }
          };
          participantChannelRef.current = channel;
          clearInterval(interval);
        } else if (retries++ >= maxRetries) {
          clearInterval(interval);
          setError('Failed to establish data channel. Please try refreshing the page.');
        }
      }, 500);
    } catch (err) {
      console.error(err);
      setError('Failed to join quiz session. The session may be invalid or expired.');
    } finally {
      setIsLoading(false);
    }
  };

  // Participant: send answer
  const handleSendAnswer = () => {
    if (!participantChannelRef.current || participantChannelRef.current.readyState !== 'open') {
      alert('Connection not ready yet!');
      return;
    }

    const msg: QuizMessage = {
      type: 'answer',
      payload: myAnswer,
    };
    participantChannelRef.current.send(JSON.stringify(msg));
    alert('Answer sent!');
  };

  return (
    <main className={`min-h-screen p-8 bg-gradient-to-br from-indigo-50 to-white ${inter.className}`}>
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl font-bold mb-8 text-indigo-900">
          Real-Time P2P Quiz
        </h1>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-md">
            <p className="text-red-800">{error}</p>
          </div>
        )}

        <div className="bg-white rounded-lg shadow-lg p-6 mb-8">
          <div className="flex items-center gap-4 mb-6">
            <div className="flex-1">
              <h2 className="text-xl font-semibold text-gray-800">
                {mode === 'creator' ? 'Quiz Creator' : 'Quiz Participant'}
              </h2>
              <p className="text-sm text-gray-500">
                Connection Status: <span className={`font-medium ${
                  connectionStatus === 'connected' ? 'text-green-600' :
                  connectionStatus === 'connecting' ? 'text-yellow-600' :
                  'text-red-600'
                }`}>{connectionStatus}</span>
              </p>
            </div>
            {!sessionId && (
              <button
                onClick={() => setMode(mode === 'creator' ? 'participant' : 'creator')}
                className="px-4 py-2 text-sm font-medium text-indigo-600 border border-indigo-600 rounded-md hover:bg-indigo-50"
              >
                Switch to {mode === 'creator' ? 'Participant' : 'Creator'} Mode
              </button>
            )}
          </div>

          {isLoading ? (
            <div className="text-center py-8">
              <p className="text-gray-500">
                {mode === 'creator' ? 'Creating quiz session...' : 'Joining quiz session...'}
              </p>
            </div>
          ) : (
            mode === 'creator' ? (
              <div className="space-y-6">
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Quiz Question
                    </label>
                    <input
                      type="text"
                      className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      value={quizQuestion}
                      onChange={(e) => setQuizQuestion(e.target.value)}
                      placeholder="Enter your question..."
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Correct Answer
                    </label>
                    <input
                      type="text"
                      className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      value={quizAnswer}
                      onChange={(e) => setQuizAnswer(e.target.value)}
                      placeholder="Enter the correct answer..."
                    />
                  </div>
                </div>

                {!creatorSessionId ? (
                  <button
                    onClick={handleCreateQuiz}
                    className="w-full px-6 py-3 text-white bg-indigo-600 rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
                  >
                    Create Quiz Session
                  </button>
                ) : (
                  <div className="space-y-4">
                    <div className="p-4 bg-gray-50 rounded-md">
                      <p className="text-sm font-medium text-gray-700 mb-2">Share this link with participants:</p>
                      <div className="flex gap-2">
                        <input
                          readOnly
                          className="flex-1 px-4 py-2 bg-white border border-gray-300 rounded-md"
                          value={`${typeof window !== 'undefined' ? window.location.origin : ''}/?session=${creatorSessionId}`}
                        />
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(
                              `${typeof window !== 'undefined' ? window.location.origin : ''}/?session=${creatorSessionId}`
                            );
                            alert('Link copied!');
                          }}
                          className="px-4 py-2 text-indigo-600 border border-indigo-600 rounded-md hover:bg-indigo-50"
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                    <button
                      onClick={handleSendQuiz}
                      className="w-full px-6 py-3 text-white bg-green-600 rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
                      disabled={connectionStatus !== 'connected'}
                    >
                      Send Quiz
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-6">
                {receivedQuiz ? (
                  <div className="space-y-4">
                    <div className="p-4 bg-gray-50 rounded-md">
                      <h3 className="text-lg font-medium text-gray-900 mb-2">
                        {receivedQuiz.question}
                      </h3>
                      <input
                        type="text"
                        className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                        value={myAnswer}
                        onChange={(e) => setMyAnswer(e.target.value)}
                        placeholder="Enter your answer..."
                      />
                    </div>
                    <button
                      onClick={handleSendAnswer}
                      className="w-full px-6 py-3 text-white bg-green-600 rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
                      disabled={connectionStatus !== 'connected'}
                    >
                      Submit Answer
                    </button>
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <p className="text-gray-500">
                      {connectionStatus === 'connected'
                        ? 'Waiting for quiz question...'
                        : 'Connecting to quiz session...'}
                    </p>
                  </div>
                )}
              </div>
            )
          )}
        </div>
      </div>
    </main>
  );
}