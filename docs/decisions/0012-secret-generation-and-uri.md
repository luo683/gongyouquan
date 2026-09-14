# 0012：密钥生成的字符集与 `DATABASE_URL` 的 URI 保留字符冲突

- 日期：2026-09-14
- 状态：open（工程侧已按本节实现，说明书本身没改）
- 关联章节：`03-AI运维手册.md` 第 3.2 节（compose 的 `DATABASE_URL` 插值）、第 4.1 节（密钥清单与生成命令）、第 4.2 节（不写进 compose）
- 关联代码：`infra/deploy/docker-compose.yml`、`infra/deploy/gen-secrets.sh`、`infra/deploy/.env.example`

## 一：手册的生成命令与手册自己的 compose 拼不出一个能用的连接串

4.1 给的命令是：

```bash
for k in POSTGRES_PASSWORD JWT_SECRET MEILI_MASTER_KEY ALERT_HMAC_SECRET RESTIC_PASSWORD; do
  printf '%s=%s\n' "$k" "$(openssl rand -base64 48)" >> .env
done
```

3.2 给的 `api` 服务是：

```yaml
DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
```

两者都是照手册写的，但**合起来会坏**：base64 的字母表里有 `/` 与 `+`，而 `DATABASE_URL` 是一个 URI，`/` 是路径分隔符、`+` 在 query 里是空格。`openssl rand -base64 48` 输出 64 个字符，每个字符命中 `/` 或 `+` 的概率是 2/64，所以**约 87% 的生成结果至少含一个**（`1 - (62/64)^64`）。第一把试的钥匙就含 `/`。

实测（2026-09-14，本机）：

| 消费者 | 输入 | 结果 |
|---|---|---|
| `pg-connection-string@2.14.0`（`apps/server` 实际用的解析器） | `postgres://app:a/b+c=d@db:5432/appdb` | `THROWS: Invalid URL` |
| 同上 | `postgres://app:a%2Fb%2Bc%3Dd@db:5432/appdb` | 解析正确 |
| `psql`（libpq） | 同上裸值 | `invalid integer value "a" for connection option "port"` |
| `psql`，密码含空格 `@ / + =` | 未编码 | `could not translate host name "ss" to address` |

好消息是**它是响亮地失败而不是静默连错库**（`new URL()` 直接抛）。坏消息是失败点在服务启动那一刻，报错里没有任何一个字指向「密码字符集」。

**当前实现决定**：`POSTGRES_PASSWORD` 用 `openssl rand -hex 32`（64 个十六进制字符 = 256 bit 熵，字符集里没有 URI 保留字符），其余四把保持 base64——它们从不被拼进 URI，只作为裸字符串参与签名与比较。这条偏离写进了 `.env.example` 的注释与 `gen-secrets.sh`。

要修的是**手册**：要么 4.1 对 `POSTGRES_PASSWORD` 单列一栏生成方式，要么 3.2 里那条 `DATABASE_URL` 改成不拼 URI（分别给 `PGHOST` / `PGUSER` / `PGPASSWORD`，让 `pg` 走键值对连接串）。取前者更省事，但要需求方确认——**熵的口径从 base64 的 384 bit 名义值变成 hex 的 256 bit 实际值，这两个都远超需要，可手册说的是 48 字节**。

## 二：`docker compose` 的必填插值同时拒绝「未设置」与「空值」，所以模板里的密钥留空

4.2 要求「compose 里全部用 `${VAR}` 引用，不出现字面值」，但没说缺变量时怎么办。取 `${VAR:?message}`：`docker compose config` 直接拒绝解析，实测输出——

```text
error while interpolating services.db.environment.POSTGRES_PASSWORD: required variable
POSTGRES_PASSWORD is missing a value: POSTGRES_PASSWORD 未设置（见 infra/deploy/.env.example）
```

关键细节是 **`:?` 对空值同样报错**。所以 `.env.example` 里那五把钥匙写成 `POSTGRES_PASSWORD=`（等号后面什么都没有），`cp` 过去没生成就必然起不来。如果写成 `POSTGRES_PASSWORD=change-me`，那这份「示例」就成了下一份被直接上线的默认值——`:?` 检查的是存在性，拦不住没改过的值。

`MEILI_MASTER_KEY` 也一并必填，尽管这个栈里**没有** meilisearch 服务（搜索走 PG pg_trgm 降级路径）。理由是 `apps/server` 的 `env.ts` 要求它非空，而把它做成必填的唯一代价是操作者多生成一次；反过来若给它一个默认值，那真加上 meilisearch 的那天，仓库里就留着一个所有人共用的 master key。

## 三：`db/01-set-password.sql` 删掉了，它写的理由没能复现

那个文件的内容是 `ALTER USER gongyouquan WITH PASSWORD 'dev-db-password-only';`，注释说「只靠 `POSTGRES_PASSWORD` 会得到一个 SCRAM verifier 与后端配置不匹配的角色，跨容器连接全部 28P01」。

两件事：

1. 它做的事情是**把凭据写进一个随仓库分发的文件**——正是 4.2「不写进 compose」想避免的东西，只是换了个位置。
2. 它声称的原因在当前镜像上复现不出来。`postgres:17-alpine` + `POSTGRES_HOST_AUTH_METHOD=scram-sha-256`，只设 `POSTGRES_PASSWORD='we1rD p@ss/w+rd=x'`，从同网络的另一个容器用百分号编码的 URI 连接：`connected as tuser`。整套栈改造成注入密钥后也是绿的：`/readyz` healthy（就绪判定要求真连上库）、`create-admin` 建号并自校验登录、`POST /api/v1/auth/login` 与带 token 的 `GET /groups` 通过。

**当前实现决定**：删文件与挂载，不改成 `.sh` 模板。理由是同一条——`initdb.d` 里放一个 `ALTER USER` 只是在为「entrypoint 自己会设密码」这件事买双保险，而那件事已经验证成立；真正的历史故障几乎肯定是第一节的字符集问题（客户端发出的密码和设置进去的不是同一个字符串）。**如果需求方坚持保留那个脚本**，那它必须是模板化写入而不是一行字面量，且要解释为什么 entrypoint 的密码不可信。

## 四：换密钥对**已有数据卷**无效，这是机制不是 bug

`POSTGRES_PASSWORD` 只在数据目录为空时被 `initdb`/entrypoint 应用一次。把 `.env` 里的值改掉再 `up -d`，数据库仍然认旧密码，而后端拿新密码去连——表现是 28P01，且报错不会提「卷是旧的」。这正是手册 4.1「轮换影响」那一栏说的「需同时改 PG 用户密码」。

本机默认项目（`gongyouquan`）那个 12 小时前建起来的 `dbdata` 卷就是这种情况，已按 `ALTER USER gongyouquan WITH PASSWORD '<新生成值>'` 轮换过（容器内 `psql` 走 localhost trust 行，所以改密码不需要旧密码），改完 `up -d` 全绿。

## 五：`gen-secrets.sh` 为什么是个脚本而不是一段说明

4.1 的 for 循环是 `>> .env` 追加，而 `.env.example` 里这五个键**已经存在**，追加会得到重复键；compose 对重复键取最后一个，于是文件里带注释的那份和生效的那份分家。`gen-secrets.sh` 改成模板替换，并且：拒绝覆盖已存在的 `.env`（「只是想再生成一份」不该把所有线上凭据换掉）、逐把校验字符集与长度、数一遍五把钥匙确实不同（共用是复制粘贴的结果，提醒不如检查）、替换完再逐个确认键真的被填上了（模板键名一旦对不上，替换会一声不响地什么都不做）。

**本机无法验证的一项**：`chmod 600`。NTFS 上 Git Bash 无论怎么设都报 `644`（`/tmp` 里也一样），脚本里那行是给 Linux 部署机写的，在 Windows 上只是不可观测，不代表它错。
