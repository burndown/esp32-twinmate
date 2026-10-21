# WireGuard 服务器（给设备当出口）

[English](wireguard-server.md) · **中文**

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

批准一台设备：设备申请后，在设置页的 WireGuard 一节（或用**管理令牌**访问网关的 `GET /wg/peers?k=管理令牌`）里找到它，把 `sudo wg set wg0 peer '…' allowed-ips 10.77.0.N/32` 在服务器上执行，再在设置页点“标记为已批准”；要让它重启后还在，把 `[Peer]` 段（`sudo wg showconf wg0`）追加进 `wg0.conf`。

注意：设备的 UDP 包只用 Wi-Fi 网卡发，所以服务器的 `ListenPort` 要对外开放；一台服务器不能同时是家里网络的路由器，因为设备走隧道时所有新连接都从服务器出去。

## 不经过网关配置设备

在固件的 Kconfig 里设置 `MUSE_WG_ENDPOINT`、`MUSE_WG_PORT`、`MUSE_WG_SERVER_KEY`（`server.pub` 的内容）和 `MUSE_WG_ADDRESS`（这台设备在隧道里的地址，例如 `10.77.0.2`）。刷机后设备会生成自己的密钥对，在设置 → WireGuard 页和开机日志里能看到公钥，然后在服务器上执行 `sudo wg set wg0 peer '<公钥>' allowed-ips 10.77.0.2/32`。网关不需要 `WG_SERVER_PUB` 和 `WG_ENDPOINT`。

## 刷机前就生成密钥

`tools/make-wg-config.py --address 10.77.0.2 --server-key <server.pub 的内容> --endpoint <服务器地址> --append my-cloud.defaults` 生成这台设备的密钥对，把含私钥的配置追加进 `my-cloud.defaults`（权限 600，不要提交），并打印服务器上要执行的 `sudo wg set …` 一行。先在服务器上执行，再刷机，设备开机就连得上。
