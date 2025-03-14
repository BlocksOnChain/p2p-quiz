// Utility function to get the host address (IP:port)
export async function getHostAddress(): Promise<string> {
  try {
    // Try to get the IP from the server 
    if (process.env.NODE_ENV === 'development') {
      const response = await fetch('/api/ip');
      if (response.ok) {
        const data = await response.json();
        return "http://" + data.address; // Will be something like "192.168.1.106:3000"
      }
    }
    else {
      return "https://" + window.location.host;
    }
  } catch (error) {
    console.error('Failed to get host address:', error);
  }
  
  // Fallback to current origin (works for single machine but not across network)
  if (typeof window !== 'undefined') {
    const host = window.location.host; // Gets something like "localhost:3000"
    return host;
  }
  
  // Ultimate fallback
  return 'localhost:3000';
} 