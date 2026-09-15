# 工友圈 备份容器 —— 运维手册 3.2 的 `backup` 服务，跑 infra/backup/ 里的五个脚本。
#
# 基座选 postgres:17-alpine 而不是 node/alpine + postgresql-client，理由是手册 8.2
# 那句「pg_dump 的大版本必须与服务器一致」：栈里的服务器就是这个镜像。分装客户端
# 就变成两件东西要对齐，而漂移只在真正需要恢复的那天暴露。跟着同一个 tag 走，对齐
# 是结构性的而不是需要提醒的。
#
# 走 daocloud 源的理由与 compose 里一样：registry-1.docker.io 在本机不可达
# （docs/decisions/0002）。
FROM docker.m.daocloud.io/library/postgres:17-alpine

# 五个包，理由不是一个而是五个：
#
#   bash        backup-once.sh 是 `set -euo pipefail`。pipefail 在这里是承重的：
#               `pg_dumpall | gzip` 这条管道里，gzip 几乎总会成功退出，于是没有
#               pipefail 时 pg_dumpall 被连接切断也报 0，交出去一个空的 globals。
#               而 postgres:17-alpine 里没有 bash（交接文档坑 20）——restore-drill.sh
#               因此刻意是 POSIX sh，因为它要跑在临时恢复容器里。这里不是那个容器。
#   openssl     notify-alert.sh 要算 HMAC-SHA256。基座镜像有 libcrypto 但**没有
#               openssl 这个命令行**，busybox 的 wget 也没有任何 HMAC 能力，而
#               /hooks/alert 只收签名过的请求。这是五个包里唯一一个「缺了就整条失败
#               路径静默」的：备份坏了没人说话，而且没有任何一行日志说为什么没人说。
#   restic      异地上传与保留策略（手册 8.1）。
#   age         .env 加密带走（手册 4.3）。缺它 backup-once.sh 会跳过 .env 而不是
#               明文落盘，所以装它不是为了少一条警告，是为了那一行真的被备份。
#   supercronic 调度器。选 apk 里的包而不是 GitHub releases 的二进制：版本由基座
#               tag 决定、apk 会按索引校验 checksum，而 curl|sh 两样都没有。
RUN apk add --no-cache bash openssl restic age supercronic

COPY infra/backup/backup-once.sh \
     infra/backup/backup-loop.sh \
     infra/backup/restore-drill.sh \
     infra/backup/backup-health.sh \
     infra/backup/notify-alert.sh \
     /usr/local/bin/
# 显式 chmod，而且它是承重的不是保险：`git ls-files -s` 显示这几个文件在仓库里就是
# **100644**（在 Windows 工作树里 add 的，执行位从来没有进过 index），所以 COPY 进去
# 就是不可执行。少了这一行，后果是凌晨三点 supercronic 拿到一个 `Permission denied`
# 写进日志没人看。
RUN chmod 755 /usr/local/bin/backup-once.sh \
              /usr/local/bin/backup-loop.sh \
              /usr/local/bin/restore-drill.sh \
              /usr/local/bin/backup-health.sh \
              /usr/local/bin/notify-alert.sh

ENV BACKUP_DIR=/backups \
    UPLOADS_DIR=/data/uploads \
    CRONTAB_FILE=/etc/crontab.ops

# 手册 3.2：备份容器不是常驻服务，而是长期运行的调度器。
ENTRYPOINT ["/usr/local/bin/backup-loop.sh"]
