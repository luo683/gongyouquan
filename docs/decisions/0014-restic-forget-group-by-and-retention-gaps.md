# 0014：手册的 `restic forget` 那一行永远不会删掉任何东西

- 日期：2026-09-15
- 状态：open（工程侧已按本节实现并实测，说明书本身没改）
- 关联章节：`03-AI运维手册.md` 第 4.3 节（`.env` 的加密异地备份）、第 6.12 节（残余风险表）、第 8.1 节（备份清单与策略）、第 8.2 节（`backup-once.sh`）、第 8.3 节（恢复演练）、第 8.5 节（RPO/RTO）
- 关联代码：`infra/backup/backup-once.sh`、`infra/backup/backup-health.sh`、`infra/deploy/docker-compose.yml`
- 前置：`0013`（`.env` 与 age 公钥的挂载）——那条解决了「密钥进不进得去」，这条解决「传上去之后呢」

## 为什么这一整节是这一轮才出现的

8.2 的 restic 那四行在仓库里躺了很久，但 `RESTIC_REPOSITORY` 一直是空的，所以 `backup-once.sh` 每次都走 `ALLOW_LOCAL_ONLY` 分支。**异地这一段从来没有被执行过**，因此也没有被检验过。这一轮真初始化了一个仓库、跑了四次备份、把取回来的 dump 灌进干净的 PG 跑完演练，才拿到下面这些结论。

先说清楚测到了什么程度，因为「备份链跑通了」这句话很容易被听成比实际更强的意思：

| 环节 | 状态 |
|---|---|
| `pg_dump -Fc` → 202 个目录对象、79,127 字节、pg 17.11 与服务器同版本 | 实测 |
| restic 0.18.1 `backup`，db / secrets / uploads 三个 tag 各一个快照 | 实测 |
| `restic check`（load indexes / check all packs / check snapshots, trees and blobs） | 实测，no errors |
| `restic restore latest --tag db` 取回的 dump 与原件 sha256 逐字节相同（`49a8defccdf3…`） | 实测 |
| 取回的那一份（不是本地暂存那一份）跑完 `restore-drill.sh` 七道验收，用户 4 / 群 4 / 成员 6 / 消息 4 / 提及 1 | 实测，PASS |
| `env-backup.age` 从仓库取回 → age 解密 → 与 `/opt/chat/.env` 逐字节相同（2,362 字节） | 实测 |
| uploads 快照 | 实测，但**是 0 B**——这台机器的 uploads 卷是空的，所以「附件真的能进能出」这一条还没有内容支撑 |
| 仓库位置 | `/backups/restic-repo`，**与备份暂存在同一个卷上**，见第七节 |

## 一：`--group-by` 缺失，于是保留策略是一行注释

8.2 第 4 步的原文是：

```sh
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
```

restic 的 `forget` 在**应用保留规则之前**要先分组，默认分组键是 `host,paths`。而 `backup-once.sh` 每晚备份的文件名里带时间戳（`db_20260915T000030.dump`），所以**每一晚的快照都是唯一的一组，每组里只有它自己一个**。`keep-daily 7` 的意思是「每天留最后一个」，一组里只有一个，那一个就永远是「最后一个」——**一个都删不掉**。

这不是推理，是实测出来的。同一个仓库、同一个 `--tag db` 过滤器、同一个 `--keep-daily 1`：

```
不加 --group-by：  keep 1 snapshots（23:55 那份） + keep 1 snapshots（23:57 那份）→ 保留 2，删除 0
加 --group-by tag：remove 1 snapshots → 保留 1，删除 1
```

用生产那一档策略（`--keep-daily 14 --keep-weekly 8 --keep-monthly 6`）再跑一次 `--dry-run`：加了 `--group-by tag` 是「keep 3 / remove 1」一次策略应用；不加则是**四次**独立的「keep N snapshots」——四个自成一体的组，删除数为 0。

后果是双向的，而且两个方向都糟：

- **仓库无限增长。** 手册 6.12 把「`forget --prune` 会按保留策略删除旧快照」列为残余风险，配的方案是「至少 6 个月的历史」。实际上它既不会删掉旧快照，也不会回收空间——风险表里那条「可能误删有用备份」根本不会发生，而「对象存储账单每月翻一倍」会。
- **保留策略看起来生效了。** 脚本退出 0，`forget` 打了一屏漂亮的表格，每一行都写着 "keep 1 snapshots"。没有人会去数它到底删了几个。这正是巡检项 21 说的「虚假的安全感」，只不过坏掉的不是文件，是回收规则。

**当前实现决定**：四条 `forget` 全部加 `--group-by tag`（见第五节的分档），`--prune` 从每条 `forget` 上摘下来，改成末尾单独一次 `restic prune`——四次 prune 会把同一批 pack 文件反复扫描四遍。

## 二：8.1 与 8.2/6.12 给的保留数字对不上

| 出处 | 说的对象 | 数字 |
|---|---|---|
| 8.1 备份清单，PostgreSQL 那一行 | 数据库 | 异地 **14 日 / 8 周 / 6 月** |
| 8.1 备份清单，上传文件那一行 | 附件 | `--keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune` |
| 8.2 脚本第 4 步 | 一条命令，四个 tag 共用 | `--keep-daily 7 --keep-weekly 4 --keep-monthly 6` |
| 6.12 残余风险表 | 泛指 | `--keep-daily 7 --keep-weekly 4 --keep-monthly 6`，并称之为「至少 6 个月的历史」 |

8.1 是**按对象分别规定**的，8.2 是**一条命令套住所有对象**。差的那一档正好是最要紧的那个：数据库能往回恢复 14 天还是 7 天。

**当前实现决定**：按 8.1 的对象级数字分两档——

```sh
restic forget --tag db      --group-by tag --keep-daily 14 --keep-weekly 8 --keep-monthly 6
restic forget --tag secrets --group-by tag --keep-daily 14 --keep-weekly 8 --keep-monthly 6
restic forget --tag uploads --group-by tag --keep-daily 7  --keep-weekly 4 --keep-monthly 6
restic forget --tag caddy   --group-by tag --keep-daily 7  --keep-weekly 4 --keep-monthly 6
```

选 8.1 而不是 8.2 的理由有两条：8.1 是策略表（标题就叫「备份清单与策略」），8.2 是它的实现示意；而 6.12 引 7/4/6 是在讨论「prune 可能删多」的风险，不是在设定保留政策。另外这个方向是**只多不少**的——把数据库的历史从 7 天拉到 14 天不会丢任何东西，最坏结果是多占空间。

**这一条仍然需要拍板**：如果真实意图是「所有对象一律 7/4/6」，那 8.1 的 PostgreSQL 那一行要改；如果是 14/8/6，那 8.2 和 6.12 都要改。三处留两处不一致，下一个人照抄哪一处取决于他先翻到第几页。

## 三：配了异地却静默退回本地，比从来没配过更危险

原来第 4 步的条件是：

```sh
if [ -n "${RESTIC_REPOSITORY:-}" ] && command -v restic >/dev/null 2>&1; then
```

`command -v restic` 挂在 `if` 的条件上，意味着**镜像里没有 restic 时，流程会一路掉进 `elif ALLOW_LOCAL_ONLY` 分支**，日志里只留一行「未配置 restic」的警告——可这句话是假的，`RESTIC_REPOSITORY` 明明配置了。

这个栈的 compose 里 `ALLOW_LOCAL_ONLY` 默认是 1（见 `0013` 第三节），所以这条静默降级路径是**默认开着**的：换基础镜像、apk 源挂掉导致 restic 没装上、或者有人把 restic 从 Dockerfile 里删了，异地备份就停了，而配置文件上那一行 `RESTIC_REPOSITORY` 依然在那里，看起来一切正常。

**当前实现决定**：`RESTIC_REPOSITORY` 非空就**只走 restic**，任何前置条件不满足都是 `die`，绝不落到本地分支：

```sh
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  command -v restic >/dev/null 2>&1 || die "配置了 RESTIC_REPOSITORY 但镜像里没有 restic —— 不会退回本地副本"
  ...
```

## 四：仓库不存在时不替你 `restic init`

未初始化时 restic 自己的表现是退出码 **10**，消息两行：

```
Fatal: repository does not exist: unable to open config file: stat /backups/restic-repo/config: no such file or directory
Is there a repository at the following location?
```

两个问题：退出 10 而不是 1（外层若按 `-eq 1` 判断会漏），以及它没有说该怎么办。**但自动 `restic init` 是一个更坏的答案**：对着一个拼错的路径 init 会**成功**，然后接下来每一天都把备份写进一个谁都不会去恢复的空目录，并且每天打一个绿色的勾。备份目标在哪、用什么凭据，是人的决定，不该由脚本在没人看的时候替人做。

**当前实现决定**：备份前 `restic cat config` 显式探测，失败就 `die`，消息里写清「核对路径与凭据后手动执行 restic init」。退出码回到 1，与其它失败一致。

## 五：附件卷没挂上不该算备份成功；caddy 保持可选

`[ -d "$UPLOADS_DIR" ] && restic backup --tag uploads "$UPLOADS_DIR"` 这一行在卷没挂上时会静默跳过，脚本继续往下走并写出 `last_success.json`。也就是说：**一个只有数据库、没有任何附件的"成功备份"**。手册 8.5 把「附件丢失窗口 ≤ 24 小时」单独列为一行指标，而这条指标在附件从未被上传过的情况下也是绿的。

**当前实现决定**：`UPLOADS_DIR` 不存在 → `die`。实测消息：

```
FATAL: UPLOADS_DIR=/data/nothing 不存在 —— 附件卷没有挂上，不会当成备份成功
```

`/caddy-data` 保持可选（目录不存在就跳过，不失败），因为这条栈里**根本没有 caddy 服务**——那是手册 3.2 有、我们还没有的组件，缺它不是配置错误。这一项和 8.1「Caddy 证书与配置：每日」之间的缺口，归在 caddy 服务本身还没做那一档，不在这里假装补上。

顺带记一个 shell 事实：`[ -d x ] && cmd` 在 `set -euo pipefail` 下**不会**因为 `[ -d x ]` 为假而让脚本退出（`set -e` 对 `&&` 列表左侧短路是例外的）。这一条是实测确认的，不是想当然——我一开始以为这几行会让脚本在第一次真跑时当场死掉，写测试脚本跑了一下才发现不会，才转去查上面那些**真的**有问题之处。改成 `if` 是为了可读，不是为了修 bug。

## 六：巡检项 22 在这个栈里原本没有数据源

8.1 的巡检项 22 是「异地备份新鲜度 = `restic snapshots --latest 1 --json` 的时间 > 26h 警告 / > 50h 严重」，而 8.2 第 5 步写的成功标志里本来就有一行 `"restic_latest":"$(restic snapshots --latest 1 --json | head -c 200)"`。

我们这边的 `last_success.json` 只有一个 `"offsite": "restic"` 字符串——**项 22 没有任何东西可以读**。

**当前实现决定**：备份后把 db 快照的 id 与时间写进标记文件。id 不是随手抓的：`restic backup --json` 最后那条 summary 里有 `snapshot_id`，拿它反查一次 `restic snapshots <id>`，确认「restic 退出 0」真的等价于「仓库里有一个列得出来的快照」——这是第 2 步 `pg_restore --list` 那个原则（只生成文件不算备份成功）在异地这一段的对应物。

```json
  "offsite": "restic",
  "restic_snapshot": "6c774f84f235c7b5197b9d2bac0f78c93ab017a776a0d5a4c3057d62a8271d8e",
  "restic_time": "2026-09-15T00:00:30.885696709Z",
```

`backup-health.sh` 现在会把快照 id 一起打进健康输出（`异地=restic 快照=6c774f84…`）。理由很实际：恢复时要用的就是这个 id，而人不该为了知道「最新那份是哪个快照」再去 cat 一次标记文件。

## 七：这一轮**没有**证明「异地」，`ALLOW_LOCAL_ONLY` 因此还不能删

上面所有绿勾都跑在 `/backups/restic-repo` 上——**和备份暂存目录在同一个卷、同一台机器上**。它证明的是 restic 这一段代码路径正确，不是手册 8.1「本地副本不是备份策略」这条规则被满足了。仓库和它声称在保护的那台机器一起消失时，一个快照都不会剩下。

所以 `0013` 第三节里那句「配上 restic 仓库之后请把 `:-1` 这个默认删掉」**这一轮没有兑现**，而且不是因为忘了：一个同机仓库不算配上异地。要删那一行，需要的是真的指向对象存储 / 另一台机器的 `RESTIC_REPOSITORY`，也就是手册 4.4 表里那对 `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET`（restic 的 s3 backend 读这两个环境变量）。这台机器给不了。

仍然缺的两件事，都不是工程问题：

1. **一把私钥在机器外的 age 密钥对。** 本轮为测通链路生成的那把私钥只在临时容器的可写层里，容器一重建就没有了——**这也意味着 `/backups/restic-repo` 里那份 `env-backup.age` 现在谁也解不开**，它是一个刻意留下的、形状正确的空壳。真要上线，得在机器外生成、只把公钥放进来。
2. **一个真的 restic 仓库。** 有了之后 `ALLOW_LOCAL_ONLY` 的 `:-1` 默认值要删，同时 `RESTIC_PASSWORD` 进入 4.4 表里那档「⚠️ 绝不能丢：丢了等于所有异地备份永久无法解密」。

另外，8.3 演练要求的完整链路里还有一段没做：`restic restore` 之后应当**从仓库恢复附件并抽查 sha256**（手册第 6 步，验收指标「文件抽查通过率 100%」）。这条要等 `files` 模块先存在——现在整个 uploads 卷是空的，抽查只能得到「0 个文件、通过率 100%」这种没有意义的结论。
