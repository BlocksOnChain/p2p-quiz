'use client';

import React, { Suspense, useState, useRef, useEffect, useCallback } from 'react';
import { createConnection, joinConnection, P2PConnection } from '@/lib/p2p';
import { useSearchParams } from 'next/navigation';
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
  // Allow the P2P layer to attach its envelope fields (e.g. messageId).
  [key: string]: unknown;
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

function HomePageContent() {
  const searchParams = useSearchParams();

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

  // Single live connection for the current role (creator or participant).
  const connectionRef = useRef<P2PConnection | null>(null);

  // Add new state for quiz settings
  const [timeLimit, setTimeLimit] = useState(60); // default 60 seconds
  const [points, setPoints] = useState(10); // default 10 points
  const [quizTimer, setQuizTimer] = useState<number | null>(null);
  const [scores, setScores] = useState<Map<string, number>>(new Map());

  // Add state for draft questions
  const [draftQuizzes, setDraftQuizzes] = useState<DraftQuiz[]>([]);

  // Add new state for tracking message delivery status
  const [messageSendingStatus, setMessageSendingStatus] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [heartbeatStatus, setHeartbeatStatus] = useState<'connected' | 'reconnecting' | 'disconnected'>('disconnected');
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastHeartbeatResponseRef = useRef<number>(0);

  // Host address used for building shareable QR/link on the creator side.
  const [hostAddress, setHostAddress] = useState<string>('');
  
  // Fetch the host address when the component mounts
  useEffect(() => {
    async function fetchHostAddress() {
      const address = await getHostAddress();
      setHostAddress(address);
    }
    fetchHostAddress();
  }, []);

  // Close the connection and stop the heartbeat when the page unmounts.
  useEffect(() => {
    return () => {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      connectionRef.current?.close();
      connectionRef.current = null;
    };
  }, []);

  // Start a best-effort heartbeat over the given connection. Heartbeats are
  // sent as unreliable messages: they are frequent, transient, and don't
  // belong in the reliable-retry queue.
  const startHeartbeat = useCallback((connection: P2PConnection) => {
    if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);

    lastHeartbeatResponseRef.current = Date.now();
    setHeartbeatStatus('connected');

    heartbeatIntervalRef.current = setInterval(() => {
      const timeSinceLastResponse = Date.now() - lastHeartbeatResponseRef.current;
      if (timeSinceLastResponse > 10_000) {
        setHeartbeatStatus('disconnected');
        setConnectionStatus('disconnected');
      } else if (timeSinceLastResponse > 5_000) {
        setHeartbeatStatus('reconnecting');
      }

      connection.sendUnreliable({ type: 'heartbeat', timestamp: Date.now() });
    }, 3000);

    return () => {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    };
  }, []);

  // Shared wiring of a P2PConnection to React state: connection/channel
  // state indicators and the common bookkeeping every screen needs.
  const wireConnection = useCallback(
    (connection: P2PConnection, label: 'Creator' | 'Participant') => {
      const unsubs: Array<() => void> = [];

      unsubs.push(
        connection.onConnectionStateChange((state) => {
          console.log(`[${label}] connection state:`, state);
          setConnectionStatus(state);
          if (state === 'connected') {
            setError(null);
          } else if (state === 'failed' || state === 'closed') {
            setError(
              label === 'Creator'
                ? 'Connection to participant lost. They may need to reconnect.'
                : 'Connection lost. Please try reconnecting.'
            );
          }
        })
      );

      unsubs.push(
        connection.onChannelStateChange((state) => {
          console.log(`[${label}] channel state:`, state);
          if (state === 'open') {
            setConnectionStatus('connected');
            setError(null);
          }
        })
      );

      return () => {
        for (const u of unsubs) u();
      };
    },
    []
  );

  // Creator: create quiz & WebRTC connection
  const handleCreateQuiz = async () => {
    setError(null);
    setIsLoading(true);
    try {
      // Tear down any previous connection first.
      connectionRef.current?.close();
      connectionRef.current = null;

      const connection = await createConnection();
      connectionRef.current = connection;
      setCreatorSessionId(connection.sessionId);

      wireConnection(connection, 'Creator');

      connection.onMessage((parsed) => {
        if (parsed.type === 'heartbeat') {
          lastHeartbeatResponseRef.current = Date.now();
          setHeartbeatStatus('connected');
          const pid = parsed.participantId;
          if (typeof pid === 'string') {
            setConnectedParticipants((prev) => {
              const updated = new Set(prev);
              updated.add(pid);
              return updated;
            });
          }
          return;
        }

        if (parsed.type === 'answer') {
          const pid = parsed.participantId;
          const payload = parsed.payload;
          if (typeof pid !== 'string' || typeof payload !== 'string') return;
          try {
            const answerData = JSON.parse(payload);
            console.log('[Creator] Received answer:', answerData);
            const newAnswer: Answer = {
              quizId: answerData.quizId,
              participantId: pid,
              answer: answerData.answer,
              timestamp: Date.now(),
              timeTaken: answerData.timeTaken,
              score: answerData.score,
            };
            setParticipantAnswers((prev) => {
              if (prev.some((a) => a.quizId === newAnswer.quizId && a.participantId === newAnswer.participantId)) {
                return prev;
              }
              return [...prev, newAnswer];
            });
            setConnectedParticipants((prev) => {
              const updated = new Set(prev);
              updated.add(pid);
              return updated;
            });
          } catch (err) {
            console.error('[Creator] Failed to parse answer payload:', err);
          }
        }
      });

      startHeartbeat(connection);
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
    const connection = connectionRef.current;
    if (!connection || connection.getChannelState() !== 'open') {
      alert('Connection is not ready yet!');
      return;
    }

    const questionsToSend =
      draftQuizzes.length > 0
        ? draftQuizzes
        : quizQuestion.trim() && quizAnswer.trim()
        ? [{ question: quizQuestion, correctAnswer: quizAnswer, timeLimit, points }]
        : [];

    if (questionsToSend.length === 0) {
      alert('Please add at least one question!');
      return;
    }

    try {
      setMessageSendingStatus('sending');
      const sentMessageIds: string[] = [];

      for (const draft of questionsToSend) {
        const newQuiz: Quiz = {
          id: Math.random().toString(36).substring(2),
          question: draft.question,
          correctAnswer: draft.correctAnswer,
          timestamp: Date.now(),
          timeLimit: draft.timeLimit,
          points: draft.points,
        };

        const message: QuizMessage = {
          type: 'quiz',
          payload: JSON.stringify(newQuiz),
        };

        const messageId = connection.sendReliable(message);
        if (messageId) sentMessageIds.push(messageId);

        setSentQuizzes((prev) => [...prev, newQuiz]);
      }

      setDraftQuizzes([]);
      setQuizQuestion('');
      setQuizAnswer('');

      setMessageSendingStatus('sent');
      setTimeout(() => setMessageSendingStatus('idle'), 2000);

      console.log(`Quizzes queued for delivery with message IDs: ${sentMessageIds.join(', ')}`);
    } catch (err) {
      console.error('Error sending quizzes:', err);
      setMessageSendingStatus('failed');
      alert('Failed to send quizzes');
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

  // Join quiz when session ID is present
  useEffect(() => {
    if (sessionId && mode === 'participant') {
      // Store the original session ID
      if (!originalSessionIdRef.current) {
        originalSessionIdRef.current = sessionId;
      }
      handleJoinQuiz(sessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, mode]);

  // Participant: join the quiz
  const handleJoinQuiz = async (sid: string) => {
    setError(null);
    setIsLoading(true);

    // Tear down any previous connection to start fresh.
    connectionRef.current?.close();
    connectionRef.current = null;

    setConnectionStatus('connecting');
    setHeartbeatStatus('disconnected');

    try {
      const connection = await joinConnection(sid, participantId);
      connectionRef.current = connection;

      wireConnection(connection, 'Participant');

      connection.onMessage((parsed) => {
        if (parsed.type === 'heartbeat') {
          lastHeartbeatResponseRef.current = Date.now();
          setHeartbeatStatus('connected');
          // Reply so the creator sees us as connected too. Include our
          // participantId so the creator can track who replied.
          connection.sendUnreliable({
            type: 'heartbeat',
            participantId,
            timestamp: Date.now(),
          });
          return;
        }

        if (parsed.type === 'quiz') {
          const payload = parsed.payload;
          if (typeof payload !== 'string') return;
          try {
            const quiz: Quiz = JSON.parse(payload);
            setReceivedQuizzes((prev) =>
              prev.find((q) => q.id === quiz.id) ? prev : [...prev, quiz]
            );
            setCurrentQuizId((current) => current || quiz.id);
          } catch (err) {
            console.error('[Participant] Failed to parse quiz payload:', err);
          }
        }
      });

      startHeartbeat(connection);
    } catch (err) {
      console.error('[Participant] Error joining quiz:', err);
      setError('Failed to join quiz session. The session may be invalid or expired.');
    } finally {
      setIsLoading(false);
    }
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
    // handleTimeUp depends on the same state this effect already observes,
    // so including it as a dep would cause the timer to restart on every
    // render without adding correctness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentQuizId, mode, myAnswers, receivedQuizzes]);

  // Handle time up for a quiz
  const handleTimeUp = (quizId: string) => {
    if (!myAnswers.has(quizId)) {
      handleSendAnswer(quizId, true);
    }
  };

  // Update answer handling to use reliable messaging
  const handleSendAnswer = (quizId: string, isTimeUp: boolean = false) => {
    const connection = connectionRef.current;
    if (!connection || connection.getChannelState() !== 'open') {
      if (!isTimeUp) alert('Connection not ready yet!');
      return;
    }

    if (scores.has(quizId)) {
      console.log(`Answer for quiz ${quizId} already submitted, ignoring duplicate submission`);
      return;
    }

    const answer = myAnswers.get(quizId) || '';
    if (!isTimeUp && !answer.trim()) {
      alert('Please enter an answer!');
      return;
    }

    const quiz = receivedQuizzes.find((q) => q.id === quizId);
    if (!quiz) return;

    const timeTaken = Math.floor((Date.now() - quiz.timestamp) / 1000);
    const isCorrect =
      answer.toLowerCase().trim() === quiz.correctAnswer.toLowerCase().trim();
    const score = isCorrect
      ? Math.max(0, quiz.points || 0) *
        (quiz.timeLimit ? Math.max(0, (quiz.timeLimit - timeTaken) / quiz.timeLimit) : 1)
      : 0;

    const msg: QuizMessage = {
      type: 'answer',
      participantId,
      payload: JSON.stringify({ quizId, answer, timeTaken, score }),
    };

    setMessageSendingStatus('sending');
    try {
      const messageId = connection.sendReliable(msg);
      // Record locally so the UI locks the answer regardless of delivery
      // timing; the reliable queue will continue retrying behind the scenes.
      setScores((prev) => new Map(prev).set(quizId, score));

      if (messageId) {
        console.log(`Queued answer for quiz ${quizId} with message ID ${messageId}`);
      }

      setMessageSendingStatus('sent');
      setTimeout(() => setMessageSendingStatus('idle'), 2000);
    } catch (err) {
      console.error('Error sending answer:', err);
      setMessageSendingStatus('failed');
      if (!isTimeUp) alert('Failed to send answer');
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

  // Reconnection: the new P2PConnection API already handles ICE restarts and
  // polling internally, so "reconnect" here means tear down the current
  // connection and redo the initial handshake. For participants we keep the
  // original session id that was shared with them.
  const attemptReconnection = useCallback(async () => {
    console.log('[Reconnection] Attempting to reestablish connection');
    try {
      if (mode === 'creator') {
        await handleCreateQuiz();
      } else if (mode === 'participant') {
        const sessionToUse = originalSessionIdRef.current || sessionId;
        if (sessionToUse) {
          await handleJoinQuiz(sessionToUse);
        }
      }
    } catch (err) {
      console.error('[Reconnection] Failed to reconnect:', err);
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(`Reconnection failed: ${message}. Please try again or refresh the page.`);
    }
    // handleCreateQuiz/handleJoinQuiz manage isLoading themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, sessionId]);

  // Auto-reconnect after a sustained outage. The P2P layer already performs
  // ICE restarts internally, so we only redo the signaling handshake if the
  // connection has been down long enough that recovery has clearly failed.
  useEffect(() => {
    if (connectionStatus === 'disconnected' || heartbeatStatus === 'disconnected') {
      const timer = setTimeout(() => {
        console.log('[Auto-reconnect] Connection has been down, attempting reconnection');
        void attemptReconnection();
      }, 15000);

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

// `useSearchParams` suspends on the client; wrap to satisfy Next.js's
// prerender contract and avoid a CSR bailout during build.
export default function HomePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen p-4 md:p-8 bg-gradient-to-br from-indigo-50 via-indigo-100 to-white flex items-center justify-center">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-10 w-10 border-4 border-indigo-300 border-t-indigo-600 mb-4"></div>
            <p className="text-indigo-800 font-medium text-lg">Loading...</p>
          </div>
        </div>
      }
    >
      <HomePageContent />
    </Suspense>
  );
}