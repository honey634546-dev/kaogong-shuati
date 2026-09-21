# 公开公务员题库导入

仓库提供了一个可重复运行的导入脚本：

```bash
npm run import:public-datasets
```

默认下载到 `data/public-datasets/`，并导入本机 `http://127.0.0.1:3210` 的自定义题库。已经下载过的文件会复用；需要刷新源文件时使用：

```bash
npm run import:public-datasets -- --refresh
```

只做下载、解析和校验而不写入题库：

```bash
npm run import:public-datasets -- --dry-run
```

## 已适配来源

- [CMMLU](https://github.com/haonan-li/CMMLU)：`chinese_civil_service_exam` 的 dev/test CSV，识别 `Question/A/B/C/D/Answer`，共 165 题。
- [LogiQA 2.0 Chinese](https://github.com/csitfun/LogiQA2.0_Chinese)：`train_zh.txt`、`dev_zh.txt`、`test_zh.txt` JSONL；自动把 0-based `answer` 转为 A-D，共 15,938 条记录。
- [C-Eval civil_servant](https://huggingface.co/datasets/ceval/ceval-exam/tree/main/civil_servant)：dev/val/test Parquet，共 481 题；Parquet 由 `scripts/read-parquet.py` 使用本机 `pyarrow` 转为记录。

三个来源均按数据源声明保留为非商业用途数据。CMMLU 和 LogiQA 2.0 Chinese 声明为 CC BY-NC-SA 4.0；C-Eval 数据集页声明为 CC BY-NC-SA 4.0。使用或再分发前应保留来源和许可证要求。

源数据没有解析的题目不会被自动编造解析；LogiQA 中源文件本身缺少题干或选项的记录会保留，但答案置空并标记为不可判分，方便后续人工修正。

## 公开真题库（gwy.gkzhenti.cn）

站点提供按科目和地区查询试卷索引的接口；每份试卷的题目页和答案页分开，导入器会按题号合并两页。当前适配器覆盖 `行测`、`申论`、`事业单位-公基`、`事业单位-职测` 和 `事业单位-综合应用` 这些分类映射。

站点页面常见来源标记为 `fenbi` 或 `网友上传`，题目页也可能是网友回忆版；页面未声明可自由再分发的开放许可证。因此这部分只提供本地、低频、可恢复的导入工具，原始 HTML 和规范化 JSON 写入已被 `.gitignore` 忽略的 `data/gkzhenti/`，不把整套站点内容提交到仓库或公开发布。

首次建议只做本地规范化，不写应用数据库：

```bash
npm run import:gkzhenti -- --cls=行测 --province=浙江 --limit=1 --no-import
```

导入器默认只处理 1 份试卷；增加 `--limit=N`，或明确使用 `--all`。它会缓存索引、题目页和答案页，并强制相邻网络请求间隔至少 61 秒；遇到站点的临时黑名单页会立即停止，不会重试、换 IP 或绕过限制。使用 `--refresh` 只应在确认站点允许重新请求时使用。

若要写入当前本地应用，服务端已启用登录时需要把当前登录会话 Cookie 通过环境变量传入，不要写进脚本或仓库：

```bash
GKZHENTI_IMPORT_COOKIE='better-auth.session_token=...' \
  npm run import:gkzhenti -- --cls=行测 --province=浙江 --limit=1
```

也可以使用 `--dry-run`；它与 `--no-import` 相同。没有公开授权的题目仍应只用于个人学习，并在对外部署或分发前单独核对来源权利。
