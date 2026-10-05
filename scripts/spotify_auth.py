# Detox — Spotify OAuth bootstrap and connection test
#
# Setup tooling, NOT pipeline code. Run by hand once to connect your Spotify
# account; the pipeline will later reuse the token file this writes.
#
#   python scripts/spotify_auth.py            # login if needed, then print your top artists
#   python scripts/spotify_auth.py --reauth   # force a fresh browser login
#
# Prerequisite: SPOTIFY_CLIENT_ID set in .env (see docs/experiments/002-spotify-releases.md).
# No client secret is required: this uses Authorization Code with PKCE.
#
# Redirect URI is fixed: http://127.0.0.1:43210/callback
# (Spotify's dashboard validator is strict — see experiment 002 for why the
# port-less and hyphenated forms get rejected. Override with
# SPOTIFY_REDIRECT_PORT in .env if 43210 is taken on your machine.)

import base64
import hashlib
import json
import os
import secrets
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(REPO_ROOT, ".env")
TOKEN_PATH = os.path.join(REPO_ROOT, "data", "spotify_tokens.json")

# Windows Store Python ships without CA certificates, which breaks the TLS
# handshake to accounts.spotify.com. Prefer certifi's bundle when installed
# (pip install certifi); urllib picks it up via SSL_CERT_FILE.
try:
    import certifi

    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
except ImportError:
    pass

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API_BASE = "https://api.spotify.com/v1"
DEFAULT_PORT = 43210

# user-top-read: the top-25 artist list (required).
# user-follow-read: optional, lets followed artists join the set later.
SCOPES = "user-top-read user-follow-read"


def load_env():
    env = {}
    if not os.path.exists(ENV_PATH):
        return env
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def save_tokens(tokens):
    os.makedirs(os.path.dirname(TOKEN_PATH), exist_ok=True)
    with open(TOKEN_PATH, "w", encoding="utf-8") as f:
        json.dump(tokens, f, indent=2)
    print("Tokens saved to", TOKEN_PATH)


def load_tokens():
    if not os.path.exists(TOKEN_PATH):
        return None
    with open(TOKEN_PATH, encoding="utf-8") as f:
        return json.load(f)


def post_token(client_id, client_secret, params):
    params = dict(params)
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    if client_secret:
        creds = base64.b64encode((client_id + ":" + client_secret).encode()).decode()
        headers["Authorization"] = "Basic " + creds
    else:
        params["client_id"] = client_id
    body = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(TOKEN_URL, data=body, headers=headers)
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def refresh_if_needed(env, tokens):
    if tokens and tokens.get("expires_at", 0) > time.time() + 60:
        return tokens
    if not tokens or not tokens.get("refresh_token"):
        return None
    print("Access token expired, refreshing...")
    out = post_token(
        env.get("SPOTIFY_CLIENT_ID"),
        env.get("SPOTIFY_CLIENT_SECRET"),
        {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]},
    )
    tokens["access_token"] = out["access_token"]
    if "refresh_token" in out:
        tokens["refresh_token"] = out["refresh_token"]
    tokens["expires_at"] = time.time() + out.get("expires_in", 3600) - 60
    save_tokens(tokens)
    return tokens


def browser_login(env):
    client_id = env.get("SPOTIFY_CLIENT_ID")
    if not client_id:
        sys.exit(
            "SPOTIFY_CLIENT_ID is not set in .env.\n"
            "Create an app at https://developer.spotify.com/dashboard\n"
            "(redirect URI: http://127.0.0.1:%d/callback) and paste its Client ID into .env."
            % int(env.get("SPOTIFY_REDIRECT_PORT", DEFAULT_PORT))
        )

    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)

    port = int(env.get("SPOTIFY_REDIRECT_PORT", DEFAULT_PORT))
    try:
        server = HTTPServer(("127.0.0.1", port), CallbackHandler)
    except OSError:
        sys.exit(
            "Port %d is already in use. Free it, or set SPOTIFY_REDIRECT_PORT in .env "
            "to another port and register that exact URI in the Spotify dashboard." % port
        )
    redirect_uri = "http://127.0.0.1:%d/callback" % port
    server.state = state
    server.result = threading.Event()
    server.error = None

    def serve():
        server.timeout = 1
        deadline = time.time() + 180
        while time.time() < deadline and not server.result.is_set():
            server.handle_request()

    threading.Thread(target=serve, daemon=True).start()

    query = urllib.parse.urlencode({
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": SCOPES,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    url = AUTH_URL + "?" + query
    print("Opening browser for Spotify login. If it does not open, visit:")
    print(" ", url)
    webbrowser.open(url)

    if not server.result.wait(180):
        sys.exit("Timed out waiting for the browser redirect. Re-run to try again.")
    if server.error:
        sys.exit("Spotify returned an error: " + server.error)

    out = post_token(client_id, env.get("SPOTIFY_CLIENT_SECRET"), {
        "grant_type": "authorization_code",
        "code": server.code,
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
    })
    tokens = {
        "access_token": out["access_token"],
        "refresh_token": out.get("refresh_token"),
        "scope": out.get("scope", SCOPES),
        "expires_at": time.time() + out.get("expires_in", 3600) - 60,
        "obtained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    save_tokens(tokens)
    return tokens


class CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/callback":
            self.send_response(404)
            self.end_headers()
            return
        params = urllib.parse.parse_qs(parsed.query)
        server = self.server
        if params.get("state", [None])[0] != server.state:
            server.error = "state mismatch"
        elif "error" in params:
            server.error = params["error"][0]
        else:
            server.code = params.get("code", [None])[0]
            server.error = None
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        message = (
            "Spotify connected. You can close this tab and return to the terminal."
            if not server.error
            else "Spotify returned an error: " + str(server.error)
        )
        self.wfile.write(message.encode())
        server.result.set()

    def log_message(self, *args):
        pass  # keep the terminal output clean


def api_get(path, params, access_token):
    url = API_BASE + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url, headers={"Authorization": "Bearer " + access_token}
    )
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def top_artists(access_token, time_range, limit=25):
    out = api_get("/me/top/artists", {"time_range": time_range, "limit": limit}, access_token)
    return out.get("items", [])


def print_top(label, artists):
    print()
    print("Top %d artists, %s:" % (len(artists), label))
    for i, artist in enumerate(artists, 1):
        genres = ", ".join(artist.get("genres", [])[:3])
        print("  %2d. %-32s %s" % (i, artist["name"], genres))


def run_test(tokens):
    access_token = tokens["access_token"]
    short = top_artists(access_token, "short_term")
    medium = top_artists(access_token, "medium_term")
    print_top("short_term (approx. last 4 weeks)", short)
    print_top("medium_term (approx. last 6 months)", medium)
    short_ids = {a["id"] for a in short}
    medium_ids = {a["id"] for a in medium}
    overlap = short_ids & medium_ids
    print()
    print("Overlap between the two lists: %d of %d" % (len(overlap), len(short_ids)))
    print("Connection OK. Access token expires %s." % time.strftime(
        "%Y-%m-%d %H:%M", time.localtime(tokens["expires_at"])))


def main():
    args = set(sys.argv[1:])
    env = load_env()
    tokens = None if "--reauth" in args else load_tokens()

    if tokens:
        tokens = refresh_if_needed(env, tokens)
    if not tokens:
        print("No stored tokens. Starting browser login...")
        tokens = browser_login(env)

    run_test(tokens)


if __name__ == "__main__":
    main()
