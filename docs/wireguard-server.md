# The WireGuard server (the exit for the device)

**English** · [中文](wireguard-server.zh-CN.md)

These are the steps to set up the exit for the device's tunnel on an Ubuntu server. The device's menu and the gateway's `/wg/enroll` are described in the README.

```bash
sudo apt-get install -y wireguard-tools
sudo sh -c 'umask 077; mkdir -p /etc/wireguard; wg genkey > /etc/wireguard/server.key'
sudo sh -c 'wg pubkey < /etc/wireguard/server.key > /etc/wireguard/server.pub'
```

`/etc/wireguard/wg0.conf` (replace `<private key>` with the contents of `server.key` and `eth0` with the outgoing network interface; permissions 600):

```ini
[Interface]
Address = 10.77.0.1/24
ListenPort = 51820
PrivateKey = <private key>
PostUp = iptables -I FORWARD 1 -i wg0 -j ACCEPT; iptables -I FORWARD 1 -o wg0 -m state --state RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -A POSTROUTING -s 10.77.0.0/24 -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -D FORWARD -o wg0 -m state --state RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -D POSTROUTING -s 10.77.0.0/24 -o eth0 -j MASQUERADE
```

```bash
sudo systemctl enable --now wg-quick@wg0     # needs net.ipv4.ip_forward=1
```

In the gateway's `.dev.vars` (or the Worker's variables) put `WG_SERVER_PUB=<the contents of server.pub>` and `WG_ENDPOINT=<the server's public IP or domain name>`. (If you use `tools/muse-cloud.py`, the `[wireguard]` section of `muse-cloud.toml` does this for you.)

To approve a device: after the device has asked, find it in the WireGuard section of the settings page (or, with the **admin token**, call the gateway's `GET /wg/peers?k=<admin token>`), run `sudo wg set wg0 peer '…' allowed-ips 10.77.0.N/32` on the server, and then press "mark as approved" on the settings page. For it to survive a reboot, append the `[Peer]` section (`sudo wg showconf wg0`) to `wg0.conf`.

Note: the device sends its UDP packets only through the Wi-Fi interface, so the server's `ListenPort` must be open to the outside (also in your hosting provider's firewall, if it has one). One server cannot also be the router of your home network, because while the device uses the tunnel every new connection leaves through the server.

## Configuring the device without the gateway

Set `MUSE_WG_ENDPOINT`, `MUSE_WG_PORT`, `MUSE_WG_SERVER_KEY` (the contents of `server.pub`) and `MUSE_WG_ADDRESS` (this device's address inside the tunnel, for example `10.77.0.2`) in the firmware's Kconfig. After flashing, the device makes its own key pair; you can read the public key on the Settings → WireGuard page and in the boot log, and then run `sudo wg set wg0 peer '<public key>' allowed-ips 10.77.0.2/32` on the server. The gateway then does not need `WG_SERVER_PUB` and `WG_ENDPOINT`.

## Making the key before flashing

`tools/make-wg-config.py --address 10.77.0.2 --server-key <the contents of server.pub> --endpoint <the server's address> --append my-cloud.defaults` makes this device's key pair, appends the settings including the private key to `my-cloud.defaults` (permissions 600; do not commit it), and prints the `sudo wg set …` line to run on the server. Run that on the server first and flash afterwards, and the device connects as soon as it boots. (`tools/muse-cloud.py firmware` does the same thing for you when `[wireguard] enabled = true`.)
