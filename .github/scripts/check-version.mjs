#!/usr/bin/env node
// 版本号与 manifest 合规检查（本地也能直接跑）
// 用法：node .github/scripts/check-version.mjs [--tag 0.8.1]
// 退出码 0 = 通过；1 = 有 error
import { readFileSync } from "node:fs";

const inActions = process.env.GITHUB_ACTIONS === "true";
const errors = [];
const warnings = [];
const notes = [];

function readJson(rel) {
  try {
    return JSON.parse(readFileSync(rel, "utf8"));
  } catch (e) {
    errors.push(`无法读取或解析 ${rel}：${e.message}`);
    return null;
  }
}

const manifest = readJson("manifest.json");
const pkg = readJson("package.json");
const versions = readJson("versions.json");
const SEMVER = /^\d+\.\d+\.\d+$/;

if (manifest && pkg && versions) {
  const mv = manifest.version;
  const pv = pkg.version;
  if (!SEMVER.test(mv ?? "")) errors.push(`manifest.json version "${mv}" 不是 x.y.z 格式`);
  if (!SEMVER.test(pv ?? "")) errors.push(`package.json version "${pv}" 不是 x.y.z 格式`);
  if (mv !== pv) errors.push(`版本号不一致：manifest.json=${mv} / package.json=${pv}`);

  const keys = Object.keys(versions);
  if (!keys.includes(mv)) errors.push(`versions.json 缺少 ${mv} 条目（新版本必须追加，旧条目不删）`);
  else if (versions[mv] !== manifest.minAppVersion)
    errors.push(
      `versions.json["${mv}"]=${versions[mv]} 与 manifest.minAppVersion=${manifest.minAppVersion} 不一致`
    );

  const newest = keys[keys.length - 1];
  if (newest !== mv) warnings.push(`versions.json 最后一条是 ${newest}，当前版本是 ${mv}`);

  // manifest 合规（非致命项只提示）
  if (!SEMVER.test(manifest.minAppVersion ?? ""))
    errors.push(`manifest.minAppVersion "${manifest.minAppVersion}" 不是 x.y.z 格式`);
  if (String(manifest.id).includes("obsidian")) warnings.push(`manifest id 不应包含 "obsidian"`);
  if (String(manifest.id).endsWith("plugin")) warnings.push(`manifest id 不应以 "plugin" 结尾`);
  if (!/^[a-z0-9-]+$/.test(String(manifest.id)))
    errors.push(`manifest id "${manifest.id}" 只允许小写字母、数字与连字符`);
  if (/plugin/i.test(manifest.name)) warnings.push(`manifest name 不应含 "Plugin"`);
  if (/obsidian/i.test(manifest.name)) warnings.push(`manifest name 不应含 "Obsidian"`);
  if (/[^\x20-\x7E]/.test(String(manifest.name))) errors.push(`manifest name "${manifest.name}" 含非 ASCII 字符`);
  const desc = manifest.description ?? "";
  if (!desc.trim()) errors.push("manifest description 为空");
  if (desc.length > 250) errors.push(`manifest description 超过 250 字符（当前 ${desc.length}）`);
  if (!/[.!?]$/.test(desc.trim())) warnings.push("manifest description 应以句号结尾");
  if (/[^\x20-\x7E]/.test(desc)) warnings.push("manifest description 含非 ASCII（官方要求英文）");
  if (!manifest.author) errors.push("manifest author 为空");
  if ("fundingUrl" in manifest && !manifest.fundingUrl) warnings.push("fundingUrl 为空字符串，不收款就删掉该字段");
}

const tagIdx = process.argv.indexOf("--tag");
if (tagIdx !== -1) {
  const tag = process.argv[tagIdx + 1];
  if (!tag) errors.push("--tag 后面缺少版本号");
  else if (manifest && tag !== manifest.version)
    errors.push(`tag "${tag}" 与 manifest.json version "${manifest.version}" 不一致（tag 不加 v 前缀）`);
}

for (const n of notes) console.log(`  ${n}`);
for (const w of warnings) console.log(inActions ? `::warning::${w}` : `  [warn] ${w}`);
for (const e of errors) console.log(inActions ? `::error::${e}` : `  [error] ${e}`);

if (errors.length) {
  console.error(`\n未通过：${errors.length} 个错误`);
  process.exit(1);
}
console.log("\n版本检查通过");
