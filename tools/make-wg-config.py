#!/usr/bin/env python3
"""Make a WireGuard key pair for one device ahead of time, so nothing has to be done at the device's first start.

  make-wg-config.py --address 10.77.0.2 --server-key SERVER_PUBLIC_KEY --endpoint your.server.example [--append my-cloud.defaults]

It prints (1) the build settings for the device and (2) the line to run on the WireGuard server. With --append the build
settings are added to that file (permissions 600). The private key is in those settings: keep the file out of git.
Pure Python, no packages: X25519 as in RFC 7748.
"""
import argparse, base64, os, secrets, stat, sys

P = 2**255 - 19
A24 = 121665

def x25519(k: bytes, u: bytes) -> bytes:
    k = bytearray(k); k[0] &= 248; k[31] &= 127; k[31] |= 64
    kk = int.from_bytes(k, "little")
    x1 = int.from_bytes(u, "little") & ((1 << 255) - 1)
    x2, z2, x3, z3, swap = 1, 0, x1, 1, 0
    for t in range(254, -1, -1):
        kt = (kk >> t) & 1
        swap ^= kt
        if swap: x2, x3, z2, z3 = x3, x2, z3, z2
        swap = kt
        a = (x2 + z2) % P; aa = a * a % P
        b = (x2 - z2) % P; bb = b * b % P
        e = (aa - bb) % P
        c = (x3 + z3) % P; d = (x3 - z3) % P
        da = d * a % P; cb = c * b % P
        x3 = pow(da + cb, 2, P); z3 = x1 * pow(da - cb, 2, P) % P
        x2 = aa * bb % P; z2 = e * (aa + A24 * e) % P
    if swap: x2, x3, z2, z3 = x3, x2, z3, z2
    return (x2 * pow(z2, P - 2, P) % P).to_bytes(32, "little")

BASE = (9).to_bytes(32, "little")

def selftest():
    # RFC 7748 section 5.2, first test vector
    k = bytes.fromhex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4")
    u = bytes.fromhex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c")
    want = "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552"
    assert x25519(k, u).hex() == want, "X25519 self-test failed"

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--address", required=True, help="this device's address inside the tunnel, e.g. 10.77.0.2")
    ap.add_argument("--server-key", required=True, help="the server's public key (server.pub)")
    ap.add_argument("--endpoint", required=True, help="the server's host name or IP")
    ap.add_argument("--port", type=int, default=51820)
    ap.add_argument("--interface", default="wg0", help="the interface name on the server")
    ap.add_argument("--append", help="add the build settings to this file (created with permissions 600)")
    a = ap.parse_args()
    selftest()
    sk = secrets.token_bytes(32)
    pk = x25519(sk, BASE)
    priv, pub = base64.b64encode(sk).decode(), base64.b64encode(pk).decode()
    cfg = f'''
# WireGuard, made by make-wg-config.py: the private key is in here, keep this file out of git
CONFIG_ESP_NETIF_BRIDGE_EN=y
CONFIG_MUSE_GATEWAY_VIA_TUNNEL=y
CONFIG_MUSE_WG_ENDPOINT="{a.endpoint}"
CONFIG_MUSE_WG_PORT={a.port}
CONFIG_MUSE_WG_SERVER_KEY="{a.server_key}"
CONFIG_MUSE_WG_ADDRESS="{a.address}"
CONFIG_MUSE_WG_PRIVATE_KEY="{priv}"
'''
    if a.append:
        fd = os.open(a.append, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a") as f: f.write(cfg)
        os.chmod(a.append, stat.S_IRUSR | stat.S_IWUSR)
        print(f"build settings added to {a.append} (permissions 600)")
    else:
        print("# --- build settings for the device ---" + cfg)
    print("# --- run this on the WireGuard server ---")
    print(f"sudo wg set {a.interface} peer '{pub}' allowed-ips {a.address}/32")
    print(f"# and to keep it after a reboot of the server, add to /etc/wireguard/{a.interface}.conf:")
    print(f"# [Peer]\n# PublicKey = {pub}\n# AllowedIPs = {a.address}/32")

if __name__ == "__main__":
    main()
