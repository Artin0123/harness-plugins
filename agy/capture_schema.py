"""Local Gemini-compatible HTTP capture server for inspecting agy CLI request schemas."""

import argparse
import http.server
import json
import os
import shutil
import subprocess
import sys
import threading
import time


def find_agy_exe() -> str:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        p = os.path.join(local_app_data, "agy", "bin", "agy.exe")
        if os.path.isfile(p):
            return p
    user_profile = os.environ.get("USERPROFILE")
    if user_profile:
        p = os.path.join(user_profile, ".gemini", "bin", "agy.exe")
        if os.path.isfile(p):
            return p
    w = shutil.which("agy")
    if w:
        return w
    return "agy"


class CaptureHandler(http.server.BaseHTTPRequestHandler):
    out_dir: str = "."
    counter: int = 0
    lock = threading.Lock()

    def log_message(self, format: str, *args) -> None:
        pass

    def _send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if "/models" in self.path:
            self._send_json(
                200,
                {
                    "models": [
                        {
                            "name": "models/gemini-3.8-flash",
                            "displayName": "Gemini 3.8 Flash",
                            "supportedGenerationMethods": ["generateContent", "streamGenerateContent"],
                        }
                    ]
                },
            )
            return
        self._send_json(200, {"status": "ok"})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b""
        with CaptureHandler.lock:
            CaptureHandler.counter += 1
            idx = CaptureHandler.counter

        os.makedirs(self.out_dir, exist_ok=True)
        out_path = os.path.join(self.out_dir, f"capture_{idx:02d}.json")
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except Exception:
            parsed = {"raw": raw.decode("utf-8", errors="replace")}

        record = {
            "method": "POST",
            "path": self.path,
            "body": parsed,
        }
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2, ensure_ascii=False)

        response_obj = {
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": [{"text": "CAPTURED_OK"}],
                    },
                    "finishReason": "STOP",
                }
            ],
            "usageMetadata": {
                "promptTokenCount": 10,
                "candidatesTokenCount": 2,
                "totalTokenCount": 12,
            },
        }
        if "alt=sse" in self.path or "streamGenerateContent" in self.path:
            sse = f"data: {json.dumps(response_obj)}\n\n".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(sse)))
            self.end_headers()
            self.wfile.write(sse)
        else:
            self._send_json(200, response_obj)


def run_server(host: str, port: int, out_dir: str) -> http.server.ThreadingHTTPServer:
    CaptureHandler.out_dir = out_dir
    server = http.server.ThreadingHTTPServer((host, port), CaptureHandler)
    return server


def main() -> int:
    parser = argparse.ArgumentParser(description="Local capture server for agy schema inspection")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="0 picks an ephemeral port")
    parser.add_argument("--out-dir", default=".")
    parser.add_argument("--agy-path", default="", help="Path to agy executable (optional, auto-detected by default)")
    parser.add_argument("--run-agy", action="store_true", help="Run agy against this server and exit")
    parser.add_argument("--agent", default="", help="Optional --agent name when --run-agy is set")
    parser.add_argument("--model", default="gemini-3.8-flash-low", help="Model name for --run-agy")
    parser.add_argument("--prompt", default="hii")
    args = parser.parse_args()

    server = run_server(args.host, args.port, args.out_dir)
    actual_port = server.server_address[1]
    base_url = f"http://{args.host}:{actual_port}"

    if not args.run_agy:
        print(f"Listening on {base_url}, saving captures to {args.out_dir}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        server.server_close()
        return 0

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    agy_exe = args.agy_path if args.agy_path else find_agy_exe()
    cmd = [
        agy_exe,
        '--settings={"modelProvider":"gemini"}',
        f"--model={args.model}",
        "--print-timeout=15s",
        f"-p={args.prompt}",
    ]
    if args.agent:
        cmd.insert(2, f"--agent={args.agent}")

    env = os.environ.copy()
    env["GEMINI_API_KEY"] = "dummy-capture-key"
    env["GOOGLE_GEMINI_BASE_URL"] = base_url

    proc = subprocess.run(cmd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(f"BASE_URL={base_url}")
    print(f"EXIT_CODE={proc.returncode}")
    print("STDOUT:", proc.stdout.strip())
    if proc.stderr.strip():
        print("STDERR:", proc.stderr.strip())
    server.shutdown()
    server.server_close()
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
