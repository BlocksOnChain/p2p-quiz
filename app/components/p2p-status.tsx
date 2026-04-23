'use client';

import React from 'react';

interface P2PStatusProps {
  connectionStatus: string;
  heartbeatStatus: string;
  messageSendingStatus: string;
  isLoading: boolean;
  onReconnect: () => void;
}

export default function P2PStatus({
  connectionStatus,
  heartbeatStatus,
  messageSendingStatus,
  isLoading,
  onReconnect
}: P2PStatusProps) {
  // Derive effective connection status based on both connection and data channel state
  const getStatusColor = () => {
    if (connectionStatus === 'connected') {
      if (heartbeatStatus === 'connected') return 'bg-green-500';
      if (heartbeatStatus === 'reconnecting') return 'bg-yellow-500';
      return 'bg-red-500';
    } else if (connectionStatus === 'connecting') {
      return 'bg-blue-500';
    } else {
      return 'bg-red-500';
    }
  };

  const getStatusText = () => {
    if (connectionStatus === 'connected') {
      if (heartbeatStatus === 'connected') return 'Connected';
      if (heartbeatStatus === 'reconnecting') return 'Connection unstable - attempting to recover...';
      return 'Connection unstable';
    } else if (connectionStatus === 'connecting') {
      return 'Establishing connection...';
    } else if (isLoading) {
      return 'Attempting to reconnect...';
    } else {
      return 'Disconnected - waiting for connection';
    }
  };

  const getStatusTextColor = () => {
    if (connectionStatus === 'connected') {
      if (heartbeatStatus === 'connected') return 'text-green-600';
      if (heartbeatStatus === 'reconnecting') return 'text-yellow-600';
      return 'text-red-600';
    } else if (connectionStatus === 'connecting') {
      return 'text-blue-600';
    } else {
      return 'text-red-600';
    }
  };

  // Only show reconnect button when truly disconnected or in a problematic state
  const shouldShowReconnect = () => {
    if (isLoading) return false; // Don't show when already reconnecting
    if (connectionStatus === 'connected' && heartbeatStatus === 'connected') return false;
    if (connectionStatus === 'connecting' && !isDataChannelStalled()) return false;
    
    return connectionStatus === 'disconnected' || 
           heartbeatStatus === 'disconnected' || 
           (heartbeatStatus === 'reconnecting' && isDataChannelStalled());
  };
  
  // Determine if we're in a stalled state that would benefit from manual reconnection
  const isDataChannelStalled = () => {
    // Consider it stalled if connection is unstable for more than a few seconds
    // This is a heuristic and could be replaced with actual timing logic
    return heartbeatStatus === 'reconnecting' || heartbeatStatus === 'disconnected';
  };
  
  // Get connection quality level (0-3) based on connection status
  const getConnectionQuality = () => {
    if (connectionStatus === 'connected' && heartbeatStatus === 'connected') return 3;
    if (connectionStatus === 'connected' && heartbeatStatus === 'reconnecting') return 2;
    if (connectionStatus === 'connecting') return 1;
    return 0;
  };

  return (
    <div className="fixed top-0 left-0 right-0 bg-white border-b border-gray-200 px-6 py-4 shadow-lg flex items-center justify-between z-50">
      <div className="flex items-center gap-3">
        <div className={`w-5 h-5 rounded-full ${getStatusColor()} animate-pulse`}></div>
        <span className={`${getStatusTextColor()} font-semibold text-lg`}>
          {getStatusText()}
          {messageSendingStatus === 'sending' && ' (Sending data...)'}
          {messageSendingStatus === 'failed' && ' (Data send failed)'}
        </span>
      </div>
      
      <div className="flex items-center gap-3">
        {/* Manual reconnect button - only show when it would be helpful */}
        {shouldShowReconnect() && (
          <button 
            onClick={onReconnect}
            disabled={isLoading}
            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white text-base rounded-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
          >
            {isLoading ? (
              <>
                <svg className="animate-spin -ml-1 mr-2 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
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
        
        {/* Connection quality indicator */}
        <div className="flex items-center gap-2 text-base text-gray-600">
          <span>Quality:</span>
          <div className="flex">
            {Array.from({ length: 3 }).map((_, i) => (
              <div 
                key={i}
                className={`w-2.5 h-6 mx-0.5 rounded-sm ${
                  i < getConnectionQuality() 
                    ? getConnectionQuality() === 3 
                      ? 'bg-green-500' 
                      : getConnectionQuality() === 2 
                        ? 'bg-yellow-500' 
                        : 'bg-red-500'
                    : 'bg-gray-300'
                }`}
              ></div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
} 