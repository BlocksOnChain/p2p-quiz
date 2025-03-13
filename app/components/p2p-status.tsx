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
  return (
    <div className="fixed top-0 left-0 right-0 bg-white border-b border-gray-200 px-6 py-4 shadow-lg flex items-center justify-between z-50">
      <div className="flex items-center gap-3">
        <div className={`w-5 h-5 rounded-full ${
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
        } font-semibold text-lg`}>
          {connectionStatus === 'connected' 
            ? heartbeatStatus === 'connected' 
              ? 'Connected' 
              : heartbeatStatus === 'reconnecting' 
                ? 'Connection unstable - attempting to reconnect...' 
                : 'Connection unstable'
            : connectionStatus === 'connecting' 
              ? 'Establishing connection...' 
              : isLoading 
                ? 'Attempting to reconnect...' 
                : 'Disconnected - waiting for connection'
          }
          {messageSendingStatus === 'sending' && ' (Sending data...)'}
          {messageSendingStatus === 'failed' && ' (Data send failed)'}
        </span>
      </div>
      
      <div className="flex items-center gap-3">
        {/* Manual reconnect button */}
        {(connectionStatus === 'disconnected' || heartbeatStatus === 'disconnected' || heartbeatStatus === 'reconnecting') && (
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
                  (connectionStatus === 'connected' && heartbeatStatus === 'connected') 
                    ? i < 3 ? 'bg-green-500' : 'bg-gray-300'
                    : (connectionStatus === 'connected' && heartbeatStatus === 'reconnecting')
                      ? i < 2 ? 'bg-yellow-500' : 'bg-gray-300'
                      : i < 1 ? 'bg-red-500' : 'bg-gray-300'
                }`}
              ></div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
} 