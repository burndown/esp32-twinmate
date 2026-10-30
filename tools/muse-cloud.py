#!/usr/bin/env python3
"""Set up the Cloudflare gateway and build the firmware from one file, muse-cloud.toml.

  muse-cloud.py init [--force]            make muse-cloud.toml from muse-cloud.example.toml, with fresh random tokens
  muse-cloud.py check                     say what is missing in muse-cloud.toml
  muse-cloud.py gateway [--dry-run]       deploy the Worker (worker/) to your Cloudflare account and push the settings to it
  muse-cloud.py firmware [--flash PORT] [--no-build]
                                          get the upstream firmware, apply the patch, write the build settings, build (and flash)
  muse-cloud.py status                    ask the deployed gateway how it is doing
  muse-cloud.py ports                     list the serial ports (find the board before flashing)

Needs Python 3.8+. The gateway step needs Node.js (it runs `npx wrangler`) and a Cloudflare account; the firmware step needs git and
ESP-IDF 6.0.1. Nothing else is installed. muse-cloud.toml holds secrets: it is created with permissions 600 and ignored by git.
"""
import argparse
import glob, base64, importlib.util, json, os, re, secrets, shlex, stat, subprocess, sys, tempfile, time
try:
    import tomllib
except ModuleNotFoundError:   # Python before 3.11: muse-cloud.toml only uses [sections], key = "text" / number / true / false, and comments
    tomllib = None
import urllib.error, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "muse-cloud.toml")
EXAMPLE = os.path.join(ROOT, "muse-cloud.example.toml")


# ---------- the config file ----------

def load():
    if not os.path.exists(CONFIG):
        sys.exit("muse-cloud.toml is not there yet: run  python3 tools/muse-cloud.py init")
    if tomllib:
        with open(CONFIG, "rb") as f:
            return tomllib.load(f)
    return parse_simple_toml(open(CONFIG).read())


def parse_simple_toml(text):
    out, cur = {}, None
    for n, raw in enumerate(text.split("\n"), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.fullmatch(r"\[(\w+)\]", line)
        if m:
            cur = out.setdefault(m.group(1), {})
            continue
        if cur is None or "=" not in line:
            sys.exit("muse-cloud.toml line %d is not understood: %s" % (n, raw))
        key, rest = line.split("=", 1)
        rest = rest.strip()
        rest = rest[:len(rest) - len(trailing_comment(rest).lstrip())].strip() if trailing_comment(rest) else rest
        if rest.startswith('"'):
            try:
                val = json.loads(rest)
            except ValueError:
                sys.exit("muse-cloud.toml line %d: text must be in double quotes" % n)
        elif rest in ("true", "false"):
            val = rest == "true"
        else:
            try:
                val = int(rest)
            except ValueError:
                sys.exit("muse-cloud.toml line %d: not understood: %s" % (n, raw))
        cur[key.strip()] = val
    return out


def trailing_comment(rest):
    """The `   # comment` at the end of the right-hand side of a line, if any (a # inside quotes does not count)."""
    inq = False
    for i, ch in enumerate(rest):
        if ch == '"':
            inq = not inq
        elif ch == "#" and not inq:
            return "  " + rest[i:].rstrip()
    return ""


def set_value(section, key, value):
    """Change one `key = value` line inside [section] and keep every comment and everything else as it is."""
    with open(CONFIG) as f:
        lines = f.read().split("\n")
    cur = None
    for i, line in enumerate(lines):
        m = re.match(r"\s*\[(\w+)\]\s*$", line)
        if m:
            cur = m.group(1)
            continue
        if cur == section and re.match(r"\s*%s\s*=" % re.escape(key), line):
            if isinstance(value, bool):
                v = "true" if value else "false"
            elif isinstance(value, int):
                v = str(value)
            else:
                v = json.dumps(value)
            lines[i] = "%s = %s%s" % (key, v, trailing_comment(line.split("=", 1)[1]))
            break
    else:
        sys.exit("muse-cloud.toml has no [%s] %s line (is it from an older version of the example?)" % (section, key))
    with open(CONFIG, "w") as f:
        f.write("\n".join(lines))
    os.chmod(CONFIG, stat.S_IRUSR | stat.S_IWUSR)


def get(cfg, section, key, default=""):
    return cfg.get(section, {}).get(key, default)


def run(cmd, cwd=None, input=None, env=None, check=True, quiet=False):
    r = subprocess.run(cmd, cwd=cwd, input=input, env=env, text=True, capture_output=True)
    if not quiet and r.stdout.strip():
        print(r.stdout.rstrip())
    if r.returncode != 0:
        if r.stderr.strip():
            print(r.stderr.rstrip(), file=sys.stderr)
        if check:
            sys.exit("command failed: " + " ".join(shlex.quote(c) for c in cmd))
    return r


# ---------- init / check ----------

def cmd_init(a):
    if os.path.exists(CONFIG) and not a.force:
        sys.exit("muse-cloud.toml already exists (use --force to start over; the tokens in it would be replaced)")
    with open(EXAMPLE) as f:
        text = f.read()
    with open(CONFIG, "w") as f:
        f.write(text)
    os.chmod(CONFIG, stat.S_IRUSR | stat.S_IWUSR)
    set_value("gateway", "device_token", secrets.token_urlsafe(24))
    set_value("gateway", "admin_token", secrets.token_urlsafe(24))
    print("made muse-cloud.toml (permissions 600) with a new device token and a new admin token.")
    print("Next: open it, fill in [muse] sdk_token and [speech] azure_key, then run:  python3 tools/muse-cloud.py gateway")


def problems(cfg, for_gateway, for_firmware, url_required=True):
    p = []
    g = cfg.get("gateway", {})
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,28}[a-z0-9]", g.get("name", "")):
        p.append('[gateway] name must be 3 to 30 characters: lowercase letters, digits and hyphens (for example "muse-gateway")')
    if not g.get("device_token") or not g.get("admin_token"):
        p.append("[gateway] device_token / admin_token are empty (run init, or put two long random strings)")
    elif g["device_token"] == g["admin_token"]:
        p.append("[gateway] device_token and admin_token must be different")
    s = cfg.get("speech", {})
    if for_gateway:
        if not s.get("azure_key"):
            p.append("[speech] azure_key is empty (speech synthesis needs an Azure Speech key)")
        if s.get("recognition") not in ("cloudflare", "azure"):
            p.append('[speech] recognition must be "cloudflare" or "azure"')
        if not re.fullmatch(r"[a-z0-9]{3,30}", s.get("azure_region", "")):
            p.append('[speech] azure_region must be a region name such as "eastasia"')
        b = cfg.get("bot", {})
        if bool(b.get("webhook_url")) != bool(b.get("auth")):
            p.append("[bot] webhook_url and auth go together")
        if b.get("webhook_url") and not b["webhook_url"].startswith("https://"):
            p.append("[bot] webhook_url must be an https address")
    if for_firmware:
        tok = get(cfg, "muse", "sdk_token")
        if len(tok) != 48 or not re.fullmatch(r"mgst_[A-Za-z0-9_-]*[AEIMQUYcgkosw048]", tok):   # the SDK's own rule (cmake/validate_config.cmake)
            p.append('[muse] sdk_token is not a valid SDK token: it is 48 characters, "mgst_" and then 43 more (copy it again from https://gadgets.muse.ai)')
        if url_required and not g.get("url"):
            p.append("[gateway] url is empty: run the gateway step first")
    w = cfg.get("wireguard", {})
    if w.get("enabled"):
        for k in ("endpoint", "server_public_key", "address"):
            if not w.get(k):
                p.append("[wireguard] %s is empty (or set enabled = false)" % k)
        if w.get("mode") not in ("off", "auto", "always"):
            p.append('[wireguard] mode must be "off", "auto" or "always"')
    return p


def cmd_check(a):
    cfg = load()
    p = problems(cfg, True, True, url_required=False)
    for line in p:
        print("-", line)
    print("everything needed is there." if not p else "\n%d thing(s) to fix." % len(p))
    if not p and not cfg["gateway"].get("url"):
        print("next: python3 tools/muse-cloud.py gateway   (it fills in [gateway] url; leave that line empty)")
    return 1 if p else 0


# ---------- the gateway ----------

WRANGLER = "wrangler@4.149.0"   # the version worker/test/lib.sh tests with; a newer one may change its output (the KV id is read from it)


def wrangler(args, cwd, input=None, check=True, quiet=False):
    return run(["npx", "--yes", WRANGLER] + args, cwd=cwd, input=input, check=check, quiet=quiet)


def http(method, url, body=None, tries=4):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"user-agent": "muse-cloud/1.0"}   # Cloudflare answers the default "Python-urllib" agent with error 1010
    if data:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except Exception as e:   # a Cloudflare address is sometimes unreachable for a moment from some networks
            last = e
            time.sleep(2)
    sys.exit("could not reach %s: %s" % (url.split("?")[0], last))


def cmd_gateway(a):
    cfg = load()
    p = problems(cfg, True, False)
    if p:
        sys.exit("muse-cloud.toml is not ready:\n- " + "\n- ".join(p))
    g = cfg["gateway"]
    worker = os.path.join(ROOT, "worker")
    gen = os.path.join(worker, "wrangler.generated.toml")
    plan = ["log in to Cloudflare (a browser window may open; with CLOUDFLARE_API_TOKEN set there is no login)",
            "create a KV namespace for the settings" if not g.get("kv_id") else "reuse the KV namespace " + g["kv_id"],
            "write worker/wrangler.generated.toml for the Worker '%s'" % g["name"],
            "set the Worker secrets GATEWAY_TOKEN and ADMIN_TOKEN", "deploy the Worker (with its Workers AI and Durable Object bindings)",
            "push the speech, bot and WireGuard settings through the Worker's settings API"]
    if a.dry_run:
        print("the gateway step would:")
        for i, s in enumerate(plan, 1):
            print(" %d. %s" % (i, s))
        return 0
    acct, token = os.environ.get("CLOUDFLARE_ACCOUNT_ID", ""), os.environ.get("CLOUDFLARE_API_TOKEN", "")
    if acct and not re.fullmatch(r"[0-9a-f]{32}", acct):
        sys.exit("CLOUDFLARE_ACCOUNT_ID must be the 32-character account ID (dash.cloudflare.com/<this>/..., or Workers & Pages > Overview), "
                 "not the account name or the e-mail address")
    who = wrangler(["whoami"], worker, check=False, quiet=True)
    if "You are not authenticated" in who.stdout + who.stderr or who.returncode != 0:
        if token:
            # a machine without a browser: wrangler login cannot work, and it refuses to run while the token is set
            sys.exit("Cloudflare refused CLOUDFLARE_API_TOKEN. Check: the token's permissions (Workers Scripts Write, Workers KV Storage Write, "
                     "Account Settings Read), its Client IP Address Filtering (error 9109 means this machine's address is not allowed), "
                     "and CLOUDFLARE_ACCOUNT_ID.\n" + (who.stdout + who.stderr).strip()[-400:])
        print("logging in to Cloudflare ...")
        subprocess.run(["npx", "--yes", WRANGLER, "login"], cwd=worker, check=True)
    kv_id = g.get("kv_id", "")
    if not kv_id:
        r = wrangler(["kv", "namespace", "create", g["name"] + "-cfg"], worker, quiet=True)
        m = re.search(r'"?\bid"?\s*[:=]\s*"([0-9a-f]{32})"', r.stdout)   # wrangler prints a TOML snippet or JSON, depending on its version
        if not m:
            sys.exit("could not read the new KV namespace id from wrangler's output:\n" + r.stdout)
        kv_id = m.group(1)
        set_value("gateway", "kv_id", kv_id)
        print("created KV namespace", kv_id)
    with open(os.path.join(worker, "wrangler.toml")) as f:
        toml = f.read()
    toml = re.sub(r'^name = ".*"$', 'name = "%s"' % g["name"], toml, count=1, flags=re.M)
    toml = toml.replace("REPLACE_WITH_KV_ID", kv_id)
    with open(gen, "w") as f:
        f.write(toml)
    for name, key in (("GATEWAY_TOKEN", "device_token"), ("ADMIN_TOKEN", "admin_token")):
        wrangler(["secret", "put", name, "-c", "wrangler.generated.toml"], worker, input=g[key], quiet=True)
        print("secret", name, "set")
    r = wrangler(["deploy", "-c", "wrangler.generated.toml"], worker, quiet=True)
    print(r.stdout.rstrip()[-600:])
    m = re.search(r"https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev", r.stdout + r.stderr)
    url = m.group(0) if m else g.get("url", "")   # the address wrangler printed wins over a hand-typed one
    if not url:
        sys.exit("deployed, but the Worker's address was not in wrangler's output: put it in [gateway] url and run this step again")
    if g.get("url") and url != g["url"]:
        print("note: [gateway] url said %s, but the Worker is at %s; using that" % (g["url"], url))
    if url != g.get("url"):
        set_value("gateway", "url", url)
    push_settings(cfg, url)
    print("\ngateway ready:", url)
    print("settings page :", "%s/admin?k=<your admin_token>" % url)
    print("next          : python3 tools/muse-cloud.py firmware")


def push_settings(cfg, url):
    s, b, w, g = cfg.get("speech", {}), cfg.get("bot", {}), cfg.get("wireguard", {}), cfg["gateway"]
    config = {"asr": {"provider": s.get("recognition", "cloudflare"), "language": s.get("language", "zh-CN")},
              "tts": {"voice": s.get("voice", ""), "region": s.get("azure_region", "eastasia")}}
    if b.get("callback_base"):
        config["bot"] = {"callback_base": b["callback_base"]}
    if w.get("enabled"):
        config["wg"] = {"server_pub": w["server_public_key"], "endpoint": w["endpoint"], "port": int(w.get("port", 51820)),
                        "subnet": w.get("subnet", "10.77.0.")}
    sec = {"azure_key": s.get("azure_key", "")}
    if b.get("webhook_url"):
        sec["grokbot_url"], sec["grokbot_auth"] = b["webhook_url"], b["auth"]
    sec = {k: v for k, v in sec.items() if v}
    code, body = http("POST", "%s/admin/api?k=%s" % (url, g["admin_token"]), {"config": config, "secrets": sec})
    if code != 200:
        sys.exit("the Worker refused the settings (HTTP %d): %s" % (code, body.decode(errors="replace")[:300]))
    print("settings pushed:", ", ".join(sorted(config)), "+ secrets:", ", ".join(sorted(sec)) or "none")


def cmd_status(a):
    cfg = load()
    g = cfg["gateway"]
    if not g.get("url"):
        sys.exit("no gateway url yet: run the gateway step")
    code, body = http("GET", "%s/health?k=%s" % (g["url"], g["admin_token"]))
    print("health:", code, body.decode(errors="replace")[:300])
    code, body = http("GET", "%s/health?k=%s" % (g["url"], g["device_token"]))
    print("device token on the admin route (should be 403):", code)
    return 0 if code == 403 else 1


# ---------- the firmware ----------

def serial_ports():
    pats = ["/dev/serial/by-id/*", "/dev/ttyACM*", "/dev/ttyUSB*", "/dev/cu.usbmodem*", "/dev/cu.usbserial*"]
    found = []
    for pat in pats:
        found += sorted(glob.glob(pat))
    return found


def cmd_ports(a):
    ports = serial_ports()
    if not ports:
        print("no serial port found: plug the board in with a USB cable that carries data (hold BOOT while plugging in if it still does not show)")
        return 1
    for pt in ports:
        extra = "" if os.access(pt, os.R_OK | os.W_OK) else "   (no permission: on Linux add yourself to the dialout group, then log in again)"
        print(pt + (" -> " + os.path.realpath(pt) if os.path.islink(pt) else "") + extra)
    print("use one of these in:  python3 tools/muse-cloud.py firmware --flash <port>   (the /dev/serial/by-id name stays the same when you plug in other boards)")
    return 0


def load_wg_module():
    spec = importlib.util.spec_from_file_location("make_wg_config", os.path.join(ROOT, "tools", "make-wg-config.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def overlay(cfg):
    g, f, w = cfg["gateway"], cfg.get("firmware", {}), cfg.get("wireguard", {})
    base, tok = g["url"].rstrip("/"), g["device_token"]
    L = ["# made by tools/muse-cloud.py from muse-cloud.toml: do not edit, do not commit (it holds tokens)",
         'CONFIG_GADGET_SDK_TOKEN="%s"' % cfg["muse"]["sdk_token"],
         'CONFIG_MUSE_STT_URL="%s/stt?k=%s"' % (base, tok), 'CONFIG_MUSE_TTS_URL="%s/tts?k=%s"' % (base, tok),
         'CONFIG_MUSE_BRAIN_URL="%s/chat?k=%s"' % (base, tok),
         'CONFIG_MUSE_STT_FALLBACK_URL=""', 'CONFIG_MUSE_TTS_FALLBACK_URL=""', 'CONFIG_MUSE_BRAIN_FALLBACK_URL=""',
         'CONFIG_MUSE_HOME_SSID="%s"' % f.get("home_ssid", ""),
         "# Cloudflare serves a cross-signed Google Trust Services chain; without this the TLS handshake fails (-0x3000)",
         "CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_CROSS_SIGNED_VERIFY=y"]
    L.append("CONFIG_MUSE_MODEL_ANSWERS=y" if f.get("model_answers") else "# CONFIG_MUSE_MODEL_ANSWERS is not set")
    L.append("CONFIG_ESP_NETIF_BRIDGE_EN=y")   # the WireGuard module is in every build, tunnel or not; the firmware needs this option anyway
    if not w.get("enabled"):
        L.append("CONFIG_MUSE_WG_DEFAULT_MODE=0")   # Off: the device does not ask the gateway for a tunnel (Settings > WireGuard can turn it on)
    if w.get("enabled"):
        L += ["CONFIG_MUSE_GATEWAY_VIA_TUNNEL=%s" % ("y" if w.get("via_tunnel", True) else "n"),
              'CONFIG_MUSE_WG_ENDPOINT="%s"' % w["endpoint"], "CONFIG_MUSE_WG_PORT=%d" % int(w.get("port", 51820)),
              'CONFIG_MUSE_WG_SERVER_KEY="%s"' % w["server_public_key"], 'CONFIG_MUSE_WG_ADDRESS="%s"' % w["address"],
              'CONFIG_MUSE_WG_PRIVATE_KEY="%s"' % w["private_key"],
              "CONFIG_MUSE_WG_DEFAULT_MODE=%d" % {"off": 0, "auto": 1, "always": 2}[w.get("mode", "auto")]]
    return "\n".join(L) + "\n"


def cmd_firmware(a):
    cfg = load()
    p = problems(cfg, False, True)
    if p:
        sys.exit("muse-cloud.toml is not ready:\n- " + "\n- ".join(p))
    f, w = cfg.get("firmware", {}), cfg.get("wireguard", {})
    if a.flash and not os.path.exists(a.flash):   # find out before the long build, not after it
        cmd_ports(a)
        sys.exit("the serial port %s does not exist (see the list above)" % a.flash)
    if not a.no_build:
        print("serial ports now:", ", ".join(serial_ports()) or "none (plug the board in before flashing; python3 tools/muse-cloud.py ports lists them)")
    work = os.path.join(ROOT, f.get("workdir", "build"))
    src = os.path.join(work, "muse-gadget-sdk")
    os.makedirs(work, exist_ok=True)
    if w.get("enabled") and not w.get("private_key"):
        mod = load_wg_module()
        mod.selftest()
        sk = secrets.token_bytes(32)
        priv, pub = base64.b64encode(sk).decode(), base64.b64encode(mod.x25519(sk, mod.BASE)).decode()
        set_value("wireguard", "private_key", priv)
        w["private_key"] = priv
        print("made this device's WireGuard key pair. Run this on the WireGuard server BEFORE the first start:\n")
        print("  sudo wg set wg0 peer '%s' allowed-ips %s/32" % (pub, w["address"]))
        print("  (and, to keep it after a reboot of the server, add a [Peer] with that PublicKey and AllowedIPs = %s/32 to wg0.conf)\n" % w["address"])
    if not os.path.isdir(os.path.join(src, ".git")):
        print("getting the upstream firmware ...")
        run(["git", "clone", f.get("upstream", "https://github.com/facebookincubator/muse-gadget-sdk.git"), src], quiet=True)
    # Always start from the pristine upstream commit and apply the patch again: whatever an earlier run left (or you edited by hand
    # in this folder) is discarded. Ignored folders (esp32/build, managed_components) are kept, so a rebuild stays fast.
    run(["git", "reset", "-q", "--hard", "--no-recurse-submodules"], cwd=src, quiet=True)
    run(["git", "checkout", "-q", "--force", f.get("upstream_commit", "e6fe517")], cwd=src, quiet=True)
    run(["git", "reset", "-q", "--hard", f.get("upstream_commit", "e6fe517")], cwd=src, quiet=True)
    run(["git", "clean", "-fdq"], cwd=src, quiet=True)
    patch = os.path.join(ROOT, "firmware", "muse-cloud.patch")
    run(["git", "apply", "--check", patch], cwd=src)
    run(["git", "apply", patch], cwd=src)
    if not os.path.exists(os.path.join(src, "esp32", "components", "muse", "muse_wg.c")):
        sys.exit("the patch did not apply completely: delete the folder %s and try again" % os.path.relpath(src, ROOT))
    print("applied firmware/muse-cloud.patch to upstream", f.get("upstream_commit", "e6fe517"))
    ov = os.path.join(work, "my-cloud.defaults")
    fd = os.open(ov, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(overlay(cfg))
    print("wrote the build settings:", os.path.relpath(ov, ROOT), "(permissions 600)")
    if a.no_build:
        return 0
    idf = os.path.expanduser(f.get("idf_path", "~/esp/esp-idf-v6.0.1"))
    if not os.path.exists(os.path.join(idf, "export.sh")):
        sys.exit("ESP-IDF 6.0.1 is not at %s: install it (https://docs.espressif.com/projects/esp-idf/en/v6.0.1/esp32s3/get-started/) "
                 "or set [firmware] idf_path" % idf)
    defaults = ";".join(["sdkconfig.defaults", "devices/sdkconfig.muse", "devices/sdkconfig.muse-waveshare-s3-175c", "devices/sdkconfig.ram", "devices/sdkconfig.badge", ov])
    script = ". %s >/dev/null 2>&1 && cd %s && idf.py -B build -DIDF_TARGET=esp32s3 -DSDKCONFIG=build/sdkconfig -DSDKCONFIG_DEFAULTS=%s build" % (
        shlex.quote(os.path.join(idf, "export.sh")), shlex.quote(os.path.join(src, "esp32")), shlex.quote(defaults))
    # build/sdkconfig keeps the values of an earlier run (and the build settings never override it): start from the settings in muse-cloud.toml every time
    stale = os.path.join(src, "esp32", "build", "sdkconfig")
    if os.path.exists(stale):
        os.remove(stale)
    print("building (the first build downloads components and takes several minutes) ...")
    r = subprocess.run(["bash", "-c", script])
    if r.returncode != 0:
        sys.exit("the build failed (the messages are above)")
    build = os.path.join(src, "esp32", "build")
    print("\nbuilt:", os.path.join(build, "muse-gadget.bin"))
    flash = ". %s >/dev/null 2>&1 && cd %s && python -m esptool --chip esp32s3 --port %s -b 460800 write-flash @flash_args"
    if a.flash:
        print("flashing ...")
        r = subprocess.run(["bash", "-c", flash % (shlex.quote(os.path.join(idf, "export.sh")), shlex.quote(build), shlex.quote(a.flash))])
        if r.returncode != 0:
            sys.exit("flashing failed. If esptool cannot connect: hold BOOT, tap RST, release BOOT, and run this again")
        print("flashed. Pair the device in the Muse app.")
    else:
        print("to flash:  python3 tools/muse-cloud.py firmware --flash <serial port>   (python3 tools/muse-cloud.py ports lists them; e.g. /dev/cu.usbmodem1101, /dev/ttyACM0 or COM5)")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("init"); s.add_argument("--force", action="store_true"); s.set_defaults(fn=cmd_init)
    sub.add_parser("check").set_defaults(fn=cmd_check)
    s = sub.add_parser("gateway"); s.add_argument("--dry-run", action="store_true"); s.set_defaults(fn=cmd_gateway)
    s = sub.add_parser("firmware"); s.add_argument("--flash", metavar="PORT"); s.add_argument("--no-build", action="store_true"); s.set_defaults(fn=cmd_firmware)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    sub.add_parser("ports").set_defaults(fn=cmd_ports)
    a = ap.parse_args()
    sys.exit(a.fn(a) or 0)


if __name__ == "__main__":
    main()
