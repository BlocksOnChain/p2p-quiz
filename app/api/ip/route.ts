import { NextResponse } from 'next/server';
import { networkInterfaces } from 'os';

export async function GET() {
  // Get all network interfaces
  const nets = networkInterfaces();
  const results = [];

  // Find a suitable IP address (non-internal IPv4 address)
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      // Skip internal and non-IPv4 addresses
      if (!net.internal && net.family === 'IPv4') {
        results.push(net.address);
      }
    }
  }

  // Get the first valid IPv4 address, or fallback to localhost
  const ipAddress = results.length > 0 ? results[0] : 'localhost';
  const port = process.env.PORT || 3000;
  
  return NextResponse.json({ 
    ip: ipAddress,
    port: port,
    address: `${ipAddress}:${port}`
  });
} 