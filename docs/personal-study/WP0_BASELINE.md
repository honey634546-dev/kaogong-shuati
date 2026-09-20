# WP0 基线记录

记录日期：2026-09-20（Asia/Shanghai）

## 代码与工作树

- 上游：`ERRRC/kaogong-shuati`
- fork：`honey634546-dev/kaogong-shuati`
- 开发分支：`codex/personal-study-platform`
- 上游/fork 基线：`a161ae62d16bf97dfdcf7a4de3bf6ea1a146d25a`
- WP0 开始时工作树：干净；未覆盖用户改动

## 运行基线

- Node：`v26.5.0`（项目声明 `>=22.5`）
- npm：`11.17.0`
- `package.json` 声明 `sharp` 和 `playwright-core`；当前 checkout 未安装 `playwright-core`
- 基线时 `package-lock.json` 的包名/版本/Node 声明仍是旧的 `fenbi-crawler` / `0.1.0` / `>=18`；WP1 已校准为当前 `package.json`
- 根目录没有 `tiku.db`，仓库也不分发题库数据
- 初始没有 `app-assets/tiku_app.db`，因此依赖该私有/生成数据的本地测试不能直接运行

## 原始测试结果

命令：`npm test`

- 结果：`65 passed / 36 failed`
- 主要阻断：服务启动硬性要求根目录 `tiku.db`；多个测试直接打开缺失的 `app-assets/tiku_app.db`；E2E 直接导入未安装的 `playwright-core` 并绑定 Edge。
- 这不是“策略或功能全部失败”的结论，而是测试环境与数据前提没有被仓库内置。

## WP1 变更后结果

命令：`npm run test:wp1`

- 结果：`2 passed / 0 failed`
- 覆盖：无题库启动、空库 API、自定义题导入、练习、判分、重启持久化。
- 默认数据目录：新安装使用 `data/`；显式 `APP_DATA_DIR` 可隔离运行；检测到旧版根目录数据库时保留兼容读取。
- 默认监听：`127.0.0.1`。

命令：`npm test`

- 结果：`72 passed / 29 failed`
- 自定义题库与本地无数据逻辑的通过数增加；剩余失败仍集中在缺失 `app-assets/tiku_app.db`、未安装 `playwright-core` 和需要真实题库内容的数量/组卷测试。

## 依赖审计

- 初始 `npm audit --omit=dev`：`sharp <0.35.4` 1 个 high，原因是底层 `libheif` 安全公告。
- 已将 `sharp` 更新为 `^0.35.4`，同步锁文件元数据和依赖版本。
- 当前 `npm audit --omit=dev`：`0 vulnerabilities`。

## 已知限制与下一步

1. WP1 还没有迁移向导；旧版数据目录通过兼容路径读取，正式迁移和备份恢复放在 WP7。
2. 自定义题目前仍沿用旧的批次/自增题 ID，稳定题目 ID、revision 和作答快照是 WP2/WP3 工作。
3. 现有 `npm test` 仍混合环境无关单测、题库 fixture 测试和浏览器 E2E；WP0 后续应拆成可重复的 fixture/mocked/integration/browser 层，不删除原有行为断言。
