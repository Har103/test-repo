//! board_ws — realtime broadcast server for the Realtime Task Board.
//!
//! Pure `std` Rust: zero dependencies. Implements by hand everything a
//! WebSocket server needs:
//!   * SHA-1  (RFC 3174)            — handshake accept key
//!   * base64                        — handshake accept encoding
//!   * RFC 6455 frames               — masking, lengths, opcodes
//!   * HTTP 1.1 parsing              — upgrade + tiny JSON API
//!
//! Endpoints (single TCP port):
//!   * `GET  /` with `Upgrade: websocket`  -> realtime WebSocket (receive only)
//!   * `POST /broadcast`                   -> fan a JSON payload to every client
//!   * `GET  /status`                      -> {"clients": n, "uptime": s}
//!
//! The PHP app POSTs every mutation here; this server fans it out to all
//! connected browsers over WebSocket.
//!
//! Security:
//!   * `/broadcast` requires `Authorization: Bearer <token>` matching
//!     `BOARD_WS_TOKEN` (default `dockup-ws-dev-token`). Without the token
//!     the endpoint answers 401, so a random network client cannot inject
//!     forged events into every open board.
//!   * Browser text frames are no longer re-broadcast (only the private
//!     ping/pong heartbeat remains), so a cross-site WebSocket cannot push
//!     anything to other clients.
//!   * If `BOARD_WS_ALLOWED_ORIGIN` is set, the WebSocket upgrade is refused
//!     unless the Origin header matches it (or is absent, e.g. non-browser
//!     clients).

use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const READ_TIMEOUT: u64 = 300;
const DEFAULT_TOKEN: &str = "dockup-ws-dev-token";

type ClientId = usize;

struct Hub {
    clients: Mutex<HashMap<ClientId, Arc<Mutex<TcpStream>>>>,
    next_id: AtomicUsize,
    started: Instant,
}

impl Hub {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            clients: Mutex::new(HashMap::new()),
            next_id: AtomicUsize::new(1),
            started: Instant::now(),
        })
    }

    fn add(&self, stream: TcpStream) -> (ClientId, Arc<Mutex<TcpStream>>) {
        let mut map = self.clients.lock().unwrap();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let shared = Arc::new(Mutex::new(stream));
        map.insert(id, Arc::clone(&shared));
        (id, shared)
    }

    fn remove(&self, id: ClientId) {
        self.clients.lock().unwrap().remove(&id);
    }

    fn count(&self) -> usize {
        self.clients.lock().unwrap().len()
    }

    /// Send a text frame to every connected client. Slow or dead clients
    /// are dropped without blocking the fan-out.
    fn broadcast(&self, payload: &[u8]) {
        let frame = build_frame(0x1, payload);
        let snapshot: Vec<Arc<Mutex<TcpStream>>> = {
            let map = self.clients.lock().unwrap();
            map.values().cloned().collect()
        };
        let mut dead = Vec::new();
        for stream in &snapshot {
            let mut s = stream.lock().unwrap();
            if s.write_all(&frame).and_then(|_| s.flush()).is_err() {
                dead.push(Arc::as_ptr(stream));
            }
        }
        if !dead.is_empty() {
            let mut map = self.clients.lock().unwrap();
            map.retain(|_, v| !dead.contains(&Arc::as_ptr(v)));
        }
    }

    /// Private text frame to one client (used for heartbeat pongs).
    fn send_to(&self, id: ClientId, payload: &[u8]) {
        let stream = self.clients.lock().unwrap().get(&id).cloned();
        if let Some(stream) = stream {
            let frame = build_frame(0x1, payload);
            let mut s = stream.lock().unwrap();
            if s.write_all(&frame).and_then(|_| s.flush()).is_err() {
                self.remove(id);
            }
        }
    }
}

fn main() {
    let port = env::args()
        .nth(1)
        .and_then(|a| a.parse::<u16>().ok())
        .unwrap_or(9001);
    let bind = format!("0.0.0.0:{}", port);
    let listener = TcpListener::bind(&bind).unwrap_or_else(|e| {
        eprintln!("could not bind {bind}: {e}");
        std::process::exit(1);
    });

    let token = env::var("BOARD_WS_TOKEN").unwrap_or_else(|_| DEFAULT_TOKEN.to_string());
    let allowed_origin = env::var("BOARD_WS_ALLOWED_ORIGIN").ok();
    let auth = Arc::new(Auth {
        token,
        allowed_origin,
    });

    let hub = Hub::new();
    println!("board_ws listening on {bind} (zero dependencies, pure std)");

    for conn in listener.incoming() {
        match conn {
            Ok(stream) => {
                let hub = Arc::clone(&hub);
                let auth = Arc::clone(&auth);
                thread::spawn(move || handle_connection(stream, hub, auth));
            }
            Err(e) => eprintln!("accept failed: {e}"),
        }
    }
}

struct Auth {
    token: String,
    allowed_origin: Option<String>,
}

/* ------------------------------ HTTP ------------------------------ */

fn handle_connection(mut stream: TcpStream, hub: Arc<Hub>, auth: Arc<Auth>) {
    stream
        .set_read_timeout(Some(Duration::from_secs(READ_TIMEOUT)))
        .ok();

    let mut buf = Vec::with_capacity(8192);
    let mut chunk = [0u8; 4096];

    // Read until the header terminator.
    loop {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if buf.len() > 64 * 1024 {
                    return;
                }
            }
        }
    }

    let (head, rest) = match find_header_end(&buf) {
        Some(i) => (&buf[..i], &buf[i..]),
        None => return,
    };
    let head = String::from_utf8_lossy(head);
    let mut lines = head.split("\r\n");

    let request_line = lines.next().unwrap_or("");
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    // ---- WebSocket upgrade ----
    if headers
        .get("upgrade")
        .is_some_and(|v| v.to_ascii_lowercase() == "websocket")
    {
        if let Some(allowed) = &auth.allowed_origin {
            match headers.get("origin") {
                Some(o) if o == allowed => {}
                Some(_) => {
                    let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
                    return;
                }
                None => {} // non-browser client without an Origin header
            }
        }
        let key = headers
            .get("sec-websocket-key")
            .cloned()
            .unwrap_or_default();
        let accept = ws_accept(&key);
        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Accept: {}\r\n\r\n",
            accept
        );
        if stream.write_all(response.as_bytes()).is_err() {
            return;
        }
        println!("ws client connected");
        ws_loop(stream, rest, hub);
        println!("ws client disconnected");
        return;
    }

    // ---- plain HTTP API ----
    http_request(stream, request_line, &headers, rest, hub, auth);
}

fn http_request(
    mut stream: TcpStream,
    request_line: &str,
    headers: &HashMap<String, String>,
    rest: &[u8],
    hub: Arc<Hub>,
    auth: Arc<Auth>,
) {
    let mut body: Vec<u8> = rest.to_vec();

    let mut content_length = 0usize;
    for line in String::from_utf8_lossy(rest).lines().take(16) {
        if let Some(v) = line.strip_prefix("content-length:") {
            content_length = v.trim().parse::<usize>().unwrap_or(0);
            break;
        }
    }
    // The body arrived in `rest` only if the client pipelined it; otherwise
    // read until Content-Length bytes arrive.
    while body.len() < content_length {
        let mut chunk = [0u8; 4096];
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let path = parts.next().unwrap_or("/");

    let (status, ctype, payload): (&str, &str, Vec<u8>) = match (method, path) {
        ("POST", "/broadcast") => {
            let bearer = headers
                .get("authorization")
                .and_then(|v| v.strip_prefix("Bearer "))
                .map(str::trim)
                .unwrap_or("");
            if bearer != auth.token {
                println!("broadcast rejected: bad token");
                (
                    "401 Unauthorized",
                    "application/json",
                    b"{\"ok\":false,\"error\":\"unauthorized\"}".to_vec(),
                )
            } else {
                let text = String::from_utf8_lossy(&body).to_string();
                println!("broadcast {} bytes to {} client(s)", text.len(), hub.count());
                hub.broadcast(text.as_bytes());
                ("200 OK", "application/json", b"{\"ok\":true}".to_vec())
            }
        }
        ("GET", "/status") => {
            let json = format!(
                "{{\"clients\":{},\"uptime\":{}}}",
                hub.count(),
                hub.started.elapsed().as_secs()
            );
            ("200 OK", "application/json", json.into_bytes())
        }
        _ => ("404 Not Found", "text/plain", b"not found".to_vec()),
    };

    let head = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        status,
        ctype,
        payload.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&payload);
}

/* --------------------------- WebSocket ---------------------------- */

/// RFC 6455 handshake: accept = base64(SHA1(key + GUID))
fn ws_accept(key: &str) -> String {
    let mut input = key.to_string();
    input.push_str(GUID);
    base64(&sha1(input.as_bytes()))
}

/// Frame loop: reads client frames, answers pings, echoes text (with a
/// private heartbeat exception), closes cleanly.
fn ws_loop(mut stream: TcpStream, leftover: &[u8], hub: Arc<Hub>) {
    // The hub keeps a clone for writes; this thread reads from the original.
    let write_clone = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let (id, _shared) = hub.add(write_clone);

    let mut frames: Vec<u8> = leftover.to_vec();

    loop {
        if frames.is_empty() {
            let mut chunk = [0u8; 4096];
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => {
                    hub.remove(id);
                    return;
                }
                Ok(n) => frames.extend_from_slice(&chunk[..n]),
            }
            continue;
        }

        match parse_frame(&frames) {
            Ok((opcode, payload, used)) => {
                frames.drain(..used);
                match opcode {
                    0x8 => {
                        // Close: answer and drop.
                        let _ = stream.write_all(&build_frame(0x8, &[]));
                        hub.remove(id);
                        return;
                    }
                    0x9 => {
                        // Ping -> pong.
                        if stream.write_all(&build_frame(0xA, &payload)).is_err() {
                            hub.remove(id);
                            return;
                        }
                    }
                    0xA => { /* pong: ignore */ }
                    0x1 | 0x0 => {
                        // Text frames from browsers were historically
                        // re-broadcast to everyone; that made a cross-site
                        // WebSocket able to push forged events into every
                        // open board. Only the private heartbeat remains.
                        let text = String::from_utf8_lossy(&payload).to_string();
                        if text == r#"{"type":"__ping"}"# {
                            hub.send_to(id, br#"{"type":"__pong"}"#);
                        }
                    }
                    _ => { /* unknown opcode: ignore */ }
                }
            }
            Err(FrameError::Incomplete) => {
                // Wait for more bytes.
                let mut chunk = [0u8; 4096];
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => {
                        hub.remove(id);
                        return;
                    }
                    Ok(n) => frames.extend_from_slice(&chunk[..n]),
                }
            }
            Err(FrameError::Protocol) => {
                let _ = stream.write_all(&build_frame(0x8, &[]));
                hub.remove(id);
                return;
            }
        }
    }
}

/* ----------------------- frames (RFC 6455) ------------------------ */

enum FrameError {
    Incomplete,
    Protocol,
}

/// Parse one client frame from `buf`. Client frames are always masked.
fn parse_frame(buf: &[u8]) -> Result<(u8, Vec<u8>, usize), FrameError> {
    if buf.len() < 2 {
        return Err(FrameError::Incomplete);
    }
    let opcode = buf[0] & 0x0F;
    let masked = buf[1] & 0x80 != 0;
    if !masked {
        return Err(FrameError::Protocol); // RFC 6455 §5.1: must be masked
    }

    let mut len = (buf[1] & 0x7F) as usize;
    let mut idx = 2usize;
    if len == 126 {
        if buf.len() < idx + 2 {
            return Err(FrameError::Incomplete);
        }
        len = u16::from_be_bytes([buf[idx], buf[idx + 1]]) as usize;
        idx += 2;
    } else if len == 127 {
        if buf.len() < idx + 8 {
            return Err(FrameError::Incomplete);
        }
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&buf[idx..idx + 8]);
        len = u64::from_be_bytes(bytes) as usize;
        idx += 8;
    }

    if buf.len() < idx + 4 + len {
        return Err(FrameError::Incomplete);
    }
    let mask = &buf[idx..idx + 4];
    idx += 4;

    let mut payload = buf[idx..idx + len].to_vec();
    for (i, b) in payload.iter_mut().enumerate() {
        *b ^= mask[i % 4];
    }

    Ok((opcode, payload, idx + len))
}

/// Build a server frame (never masked).
fn build_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(payload.len() + 10);
    frame.push(0x80 | opcode); // FIN + opcode

    let len = payload.len();
    if len < 126 {
        frame.push(len as u8);
    } else if len <= 0xFFFF {
        frame.push(126);
        frame.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(len as u64).to_be_bytes());
    }
    frame.extend_from_slice(payload);
    frame
}

/* ---------------------------- SHA-1 ------------------------------- */

fn sha1(input: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let bit_len = (input.len() as u64).wrapping_mul(8);

    let mut msg = input.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for block in msg.chunks_exact(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }

        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);

        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let tmp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = tmp;
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }

    let mut out = [0u8; 20];
    for (i, v) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

/* --------------------------- base64 ------------------------------- */

fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);

    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 0x3F] as char);
        out.push(TABLE[(n >> 12) as usize & 0x3F] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 0x3F] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 0x3F] as char } else { '=' });
    }
    out
}

/* ---------------------------- helpers ----------------------------- */

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}
