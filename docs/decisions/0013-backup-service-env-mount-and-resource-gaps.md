# 0013：手册的 backup 服务定义无法完成手册自己要求的 `.env` 备份

- 日期：2026-09-14
- 状态：open（工程侧已按本节实现，说明书本身没改）
- 关联章节：`03-AI运维手册.md` 第 2.4 节（容器资源上限）、第 3.2 节（`backup` 服务定义）、第 4.3 节（`.env` 要 age 加密随备份带走）、第 8.1 节（本地副本不是备份策略）
- 关联代码：`infra/backup/Dockerfile`、`infra/backup/backup-once.sh`、`infra/backup/backup-loop.sh`、`infra/backup/backup-health.sh`、`infra/deploy/docker-compose.yml`

## 一：3.2 的 `backup` 服务读不到 `.env`，而 4.3 要求把它加密带走

4.3 的原文要求是：`.env` 用 age 加密后与数据库备份一起送异地。理由写得很清楚——`RESTIC_PASSWORD` 本身如果不备份，那些异地副本就永远解不开，「加密备份密钥而不备份密钥本身」等于备份了一堆随机数据。

但 3.2 给的 `backup` 服务是这样挂载的：

```yaml
    env_file: [.env]
    volumes:
      - uploads:/data/uploads:ro
      - backups:/backups
```

`env_file` 的作用是把文件里的**值注入进程环境**，它不在容器文件系统里留下一个可读的 `.env`。所以按 3.2 原样实现，容器里既没有 `.env` 这个文件（`backup-once.sh` 的 `ENV_FILE=/opt/chat/.env` 找不到东西，只能走「跳过并警告」那条路），也没有任何地方放 age 公钥。**4.3 在 3.2 的定义下不可能实现**，而且失败方式是一行每天重复、没人读的警告。

**当前实现决定**：在 `infra/deploy/docker-compose.yml` 的 `backup` 服务上补两个只读挂载——

```yaml
      - ./.env:/opt/chat/.env:ro
      - ./age:/etc/age:ro
```

两条都是刻意的，理由各不相同：

- `.env` 必须只读。这个容器的职责是搬运秘密，不是轮换秘密；可写挂载意味着备份脚本里的一个 bug 能改写整栈赖以认证的凭据。
- **挂 `age/` 目录而不是 `age/recipient.pub` 文件**。Docker 对一个「源文件不存在」的 bind mount 的回应是**在目标处造一个空目录**，于是 `age -r "$(cat /etc/age/recipient.pub)"` 会报一个和「操作员还没放公钥」毫无关系的路径错误；挂目录则文件缺失就是文件缺失，`backup-once.sh` 走它设计好的那条「跳过、警告、绝不明文落盘」的路。这与 `.env` 那行注释里记的是同一个坑。
- `infra/deploy/age/` 整目录进了 `.gitignore`。里面**只应该**有 `recipient.pub`，但唯一的规则是连目录一起忽略——因为 operator 会「临时把私钥也放进来一下，好试试解密能不能通」，而那次临时就是这次事故。

实测这条链是通的（2026-09-14）：机器外 `age-keygen -o` 生成密钥对，只把 `age-keygen -y` 的输出放进挂载目录 → `backup-once.sh` 打出 `age 加密 .env -> /backups/env-backup.age` → 用机器外那把私钥解密 → 与容器内 `/opt/chat/.env` **逐字节相同**；密文头部是 `age-encryption.org/v1 -> X25519`，且不含任何明文的键名。

## 二：`mem_limit` 用 256m，而不是 2.4 表里的 100m

2.4 的资源表给 `backup`（定时容器）写的是 **100 MB / 0.5 CPU**，备注「仅 03:00-04:00 活跃」。

实现用的是 `mem_limit: 256m`（`cpus: 0.5` 与手册一致）。超出的一百多兆正好花在这个容器最不能省的两件事上：`pg_dump -Fc -Z6` 的压缩缓冲，和 restic 的上传缓冲。

**为什么值得偏离这张表**：超限的后果不是变慢而是**被 cgroup 杀掉**，而被杀是无预警的——`backup-once.sh` 死在管道中间，连 `ERR` trap 都不一定来得及跑（`notify-alert.sh` 属于还没开始的 `ops` 模块，此刻镜像里根本没有这个文件）。于是运维看到的仍然是一个 `Up` 的容器和一个昨天的 `last_success.json`。手册 8.1 巡检项 21 的原话是「文件坏了比没备份更危险——它带来虚假的安全感」，而被 OOM 杀掉的中途产物正是这种东西。

需要说清楚的是：**这个数字没有实测依据**。本轮的 dump 只有 78,735 字节（3 条消息的开发库），压缩与上传都远未触及上限。所以 `cpus`/`mem_limit` 里真正待定的是内存，上线前必须按生产数据量重跑一次并记录峰值 RSS，而不是把这个数当结论抄进部署清单。

## 三：`ALLOW_LOCAL_ONLY` 是手册里没有的变量，它把 8.1 的一条硬规则变成了显式例外

8.1 的立场是没有例外的：本地副本不是备份策略。`backup-once.sh` 按这个立场实现——没有 `RESTIC_REPOSITORY` 时**直接 `exit 1`**。

但 3.2 的 compose 写的是 `RESTIC_REPOSITORY: ${RESTIC_REPOSITORY}`，没有任何默认值；照 8.1 的硬立场，一台还没配好对象存储的机器上 `docker compose up -d` 会得到一个**反复重启的 backup 容器**，而它红得和「备份真的坏了」一模一样。

**当前实现决定**：新增 `ALLOW_LOCAL_ONLY`，compose 里默认 `:-1`，也就是本机栈今天就是靠它起起来的。这个默认值有三处自我限制，刻意不让它看起来像正常状态：

1. `backup-once.sh` 每次跑都往 stderr 打一行警告；
2. `last_success.json` 里记 `"offsite": "local-only"`，这是**数据**不是日志，巡检脚本可以据此判定；
3. `backup-health.sh` 把它带进健康检查输出（`ok：上次备份 0 小时前，异地=local-only`）。

第 3 条有个反面论证值得记下来：**没有把 local-only 判成不健康**。理由是「一个总是红的灯没有人读」——装机第一天还没配 restic 是正常路径，让它失败会让人学会忽略这个容器的状态。所以让它可见，不让它失败。这与第二节 `mem_limit` 的取舍是同一类判断，只是方向相反。

显式设 `ALLOW_LOCAL_ONLY=0` 且没有 restic 时仍然 `FATAL: 未配置 RESTIC_REPOSITORY…` 并以 1 退出（实测）。**这条默认值必须在配上 restic 仓库之后从栈里删掉**；它留在 compose 里的每一天，都等于 8.1 那条规则没有生效。

## 四：一处小的——`restic` 没有 `--version`

`backup-loop.sh` 启动时自检工具链，最初四个工具统一用 `$TOOL --version`，而 restic 的版本是 `restic version` 子命令。结果是那份「工具链到底在不在」的证据日志打出了 `restic: unknown flag: --version`——**看起来像装坏了**，而它恰恰是用来证明没装坏的东西。

不是手册的矛盾，记在这里是因为它属于同一类错误：**为「出问题时有人能看懂」而写的诊断输出，自己也得出错得起的格式**。修法是每个工具各自给版本命令，实测输出 `pg_dump (PostgreSQL) 17.11` / `restic 0.18.1` / `age v1.3.1`。

顺带一条与本节同源的：镜像设了 `ENTRYPOINT` 之后，`docker run IMAGE sh -c '…'` 是把 `sh -c …` 当**参数交给 entrypoint**，不是替换它。一次性调用镜像里的工具必须 `--entrypoint sh`（详见 `docs/HANDOVER.md` §11 坑 26）。
