# 工友圈 备份容器 —— 运维手册 3.2 的 `backup` 服务，跑 infra/backup/ 里的三个脚本。
#
# 基座选 postgres:17-alpine 而不是 node/alpine + postgresql-client，理由是手册 8.2
# 那句「pg_dump 的大版本必须与服务器一致」：栈里的服务器就是这个镜像。分装客户端
# 就变成两件东西要对齐，而漂移只在真正需要恢复的那天暴露。跟着同一个 tag 走，对齐
# 是结构性的而不是需要提醒的。
#
# 走 daocloud 源的理由与 compose 里一样：registry-1.docker.io 在本机不可达
# （docs/decisions/0002）。
FROM docker.m.daocloud.io/library/postgres:17-alpine

# 四个包，理由不是一个而是四个：
#
#   bash        backup-once.sh 是 `set -euo pipefail`。pipefail 在这里是承重的：
#               `pg_dumpall | gzip` 这条管道里，gzip 几乎总会成功退出，于是没有
#               pipefail 时 pg_dumpall 被连接切断也报 0，交出去一个空的 globals。
#               而 postgres:17-alpine 里没有 bash（交接文档坑 20）——restore-drill.sh
#               因此刻意是 POSIX sh，因为它要跑在临时恢复容器里。这里不是那个容器。
#   restic      异地上传与保留策略（手册 8.1）。
#   age         .env 加密带走（手册 4.3）。缺它 backup-once.sh 会跳过 .env 而不是
#               明文落盘，所以装它不是为了少一条警告，是为了那一行真的被备份。
#   supercronic 调度器。选 apk 里的包而不是 GitHub releases 的二进制：版本由基座
#               tag 决定、apk 会按索引校验 checksum，而 curl|sh 两样都没有。
RUN apk add --no-cache bash restic age supercronic

COPY infra/backup/backup-once.sh \
     infra/backup/backup-loop.sh \
     infra/backup/restore-drill.sh \
     infra/backup/backup-health.sh \
     /usr/local/bin/
# 显式 chmod：git 里这三个文件是 100755，但从 Windows 工作树构建时执行位不一定过
# 得去，而后果是凌晨三点一个 `Permission denied` 写进日志没人看。
RUN chmod 755 /usr/local/bin/backup-once.sh \
              /usr/local/bin/backup-loop.sh \
              /usr/local/bin/restore-drill.sh \
              /usr/local/bin/backup-health.sh

ENV BACKUP_DIR=/backups \
    UPLOADS_DIR=/data/uploads \
    CRONTAB_FILE=/etc/crontab.ops

# 手册 3.2：备份容器不是常驻服务，而是长期运行的调度器。
ENTRYPOINT ["/usr/local/bin/backup-loop.sh"]
