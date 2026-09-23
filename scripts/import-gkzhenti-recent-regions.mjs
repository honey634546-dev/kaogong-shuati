#!/usr/bin/env node

/**
 * Sequentially scan the site's listed 行测 regions for 2025–2026 papers.
 * Each child shares the importer's persistent 61-second network cooldown and
 * cache. This deliberately does not import into the app or retry failures.
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMPORTER = join(ROOT, 'scripts', 'import-gkzhenti.mjs');

export const XINGCE_REGIONS = Object.freeze([
  '国考', '联考', '浙江', '山东', '江苏', '广东', '四川', '福建', '广西', '安徽',
  '上海', '北京', '辽宁', '天津', '河北', '海南', '河南', '江西', '湖南', '湖北',
  '山西', '内蒙古', '吉林', '黑龙江', '贵州', '重庆', '陕西', '甘肃', '云南', '新疆',
  '宁夏', '青海', '西藏', '深圳', '广州',
]);

function runRegion(region, index, count) {
  console.log(`\n[${index + 1}/${count}] 开始扫描行测/${region}（2025–2026）`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      IMPORTER,
      '--cls=行测',
      `--province=${region}`,
      '--year-from=2025',
      '--year-to=2026',
      '--require-year',
      '--all',
      '--no-import',
      '--allow-empty',
    ], { cwd: ROOT, stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`行测/${region} 扫描中止（${signal ? `signal ${signal}` : `exit ${code}`}）；未自动重试。`));
    });
  });
}

async function main() {
  const startAt = process.argv.find((arg) => arg.startsWith('--start-at='))?.slice('--start-at='.length);
  const startIndex = startAt ? XINGCE_REGIONS.indexOf(startAt) : 0;
  if (startAt && startIndex < 0) throw new Error(`未知地区：${startAt}`);
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit-regions='));
  const limit = limitArg ? Number(limitArg.slice('--limit-regions='.length)) : Infinity;
  if (!(limit > 0)) throw new Error('--limit-regions 必须是正整数');
  const regions = XINGCE_REGIONS.slice(startIndex, startIndex + limit);
  for (let index = 0; index < regions.length; index += 1) {
    await runRegion(regions[index], startIndex + index, XINGCE_REGIONS.length);
  }
  console.log(`\n完成本轮扫描：${regions.length} 个地区；仅下载并规范化，不导入应用题库。`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  main().catch((error) => {
    console.error(`行测地区批量扫描失败：${error.message}`);
    process.exitCode = 1;
  });
}
