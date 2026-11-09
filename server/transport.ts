import type {NativeConnection} from './types.js';
import net from 'node:net';
import {EventEmitter} from 'node:events';

/** Legacy Haskell wstunnel transport used by the supplied Windows helper.
 * Primary reference: erebe/wstunnel haskell/src/Tunnel.hs toPath (231-242),
 * src/Types.hs ToConnection WS.Connection (102-105), app/Main.hs default (179).
 * Each tunnel is an ordinary RFC6455 binary WebSocket carrying a TCP byte stream.
 */
export function tunnelUrl(connection: NativeConnection,port: number){
 const url=new URL(connection.wsurl ?? '');
 if(!['wss:','ws:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid WebSocket tunnel endpoint');
 if(url.protocol==='ws:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Remote WebSocket tunnels require WSS');
 const prefix=connection.tunnelPrefix??'wstunnel';
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(prefix)||!/^[A-Za-z0-9_.:-]{1,253}$/.test(connection.host))throw new Error('Invalid WebSocket tunnel destination');
 url.pathname=`/${prefix}/tcp/${connection.host}/${port}`;url.search='';url.hash='';return url.href;
}

/**
 * Adapt binary WebSocket messages to the small net.Socket surface used by the
 * session and RPC clients. WebSocket message boundaries are not native frames.
 */
export class TunnelSocket extends EventEmitter{
 destroyed: boolean; open: boolean; websocket: WebSocket;
 constructor(connection: NativeConnection,port: number){
  super();this.destroyed=false;this.open=false;
  if(typeof WebSocket!=='function')throw new Error('WebSocket worlds require Node.js 22 or newer');
  this.websocket=new WebSocket(tunnelUrl(connection,port));this.websocket.binaryType='arraybuffer';
  this.websocket.addEventListener('open',()=>{if(this.destroyed)return;this.open=true;this.emit('connect');});
  this.websocket.addEventListener('message',event=>{if(this.destroyed)return;if(typeof event.data==='string'){this.emit('error',new Error('Tunnel sent text instead of a binary TCP stream'));this.destroy();return;}this.emit('data',Buffer.from(event.data as ArrayBuffer));});
  this.websocket.addEventListener('error',()=>{if(!this.destroyed)this.emit('error',new Error('WebSocket tunnel could not be established'));});
  this.websocket.addEventListener('close',()=>this.finish());
 }
 setNoDelay(_enabled = true){return this;}
 // Bound the queued outbound bytes because browser-style WebSocket has no
 // drain event matching net.Socket's backpressure contract.
 write(data: Uint8Array){if(this.destroyed||!this.open)throw new Error('WebSocket tunnel is not connected');if(this.websocket.bufferedAmount>2*1024*1024)throw new Error('WebSocket tunnel output buffer is full');this.websocket.send(new Uint8Array(data));return true;}
 end(){if(this.destroyed)return;this.websocket.close();}
 destroy(){if(this.destroyed)return;this.websocket.close();this.finish();}
 // Both explicit destruction and a remote close can reach here; emit lifecycle
 // events once so pending native operations are not torn down twice.
 finish(){if(this.destroyed)return;this.destroyed=true;this.open=false;this.emit('end');this.emit('close');}
}

/** Select transport once, leaving framing and native authentication to the caller. */
export function createNativeSocket(connection: NativeConnection,port=connection.worldPort){
 return connection.transport==='wstunnel'?new TunnelSocket(connection,port):net.createConnection({host:connection.host,port});
}
