# WireGuard 服务器（给设备当出口）

下面是在一台 Ubuntu 服务器上搭设备隧道出口的步骤，设备的菜单和网关的 `/wg/enroll` 见 README。

```bash
sudo apt-get install -y wireguard-tools
sudo sh -c 'umask 077; mkdir -p /etc/wireguard; wg genkey > /etc/wireguard/server.key'
sudo sh -c 'wg pubkey < /etc/wireguard/server.key > /etc/wireguard/server.pub'
```

`/etc/wireguard/wg0.conf`（把 `<私钥>` 换成 `server.key` 的内容，`eth0` 换成出口网卡，权限 600）：

```ini
[Interface]
Address = 10.77.0.1/24
ListenPort = 51820
PrivateKey = <私钥>
PostUp = iptables -I FORWARD 1 -i wg0 -j ACCEPT; iptables -I FORWARD 1 -o wg0 -m state --state RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -A POSTROUTING -s 10.77.0.0/24 -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -D FORWARD -o wg0 -m state --state RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -D POSTROUTING -s 10.77.0.0/24 -o eth0 -j MASQUERADE
```

```bash
sudo systemctl enable --now wg-quick@wg0     # 要开 net.ipv4.ip_forward=1
```

网关的 `.dev.vars`（或 Worker 的变量）里写：`WG_SERVER_PUB=<server.pub 的内容>`、`WG_ENDPOINT=<服务器公网 IP 或域名>`。

批准一台设备：设备申请后，访问网关 `GET /wg/peers?k=令牌`，把里面的 `sudo wg set wg0 peer '…' allowed-ips 10.77.0.N/32` 在服务器上执行；要让它重启后还在，把 `[Peer]` 段（`sudo wg showconf wg0`）追加进 `wg0.conf`。

注意：设备的 UDP 包只用 Wi-Fi 网卡发，所以服务器的 `ListenPort` 要对外开放；一台服务器不能同时是家里网络的路由器，因为设备走隧道时所有新连接都从服务器出去。
