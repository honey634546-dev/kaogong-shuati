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
