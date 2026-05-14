const fs = require("fs");
const core = require("@actions/core");
const github = require("@actions/github");
const { Octokit } = require("@octokit/rest");

main().catch((e) => core.setFailed(e.message));


const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// 速率限制控制器（单分钟窗口 + 每小时上限）
class RateLimiter {
  constructor(maxPerMinute = 75, maxPerHour = 450) {
    this.maxPerMinute = maxPerMinute;
    this.maxPerHour = maxPerHour;
    this.minuteCount = 0;
    this.hourCount = 0;
    this.minuteStart = Date.now();
    this.hourStart = Date.now();
  }

  // 等待直到可以发送下一个请求
  async waitForSlot() {
    const now = Date.now();

    // 重置分钟窗口
    if (now - this.minuteStart >= 60_000) {
      this.minuteStart = now;
      this.minuteCount = 0;
    }
    // 重置小时窗口
    if (now - this.hourStart >= 3_600_000) {
      this.hourStart = now;
      this.hourCount = 0;
    }

    // 如果分钟配额用完，等到下一秒
    if (this.minuteCount >= this.maxPerMinute) {
      const nextMinute = this.minuteStart + 60_000;
      core.info(`Hit minute rate limit (${this.maxPerMinute}/min), waiting until next window...`);
      await delay(nextMinute - now + 100); // 多等 100ms 确保重置
      return this.waitForSlot(); // 递归检查
    }

    // 如果小时配额用完，等待到小时窗口重置
    if (this.hourCount >= this.maxPerHour) {
      const nextHour = this.hourStart + 3_600_000;
      core.info(`Hit hourly rate limit (${this.maxPerHour}/hr), waiting until next window...`);
      await delay(nextHour - now + 100);
      return this.waitForSlot();
    }

    // 消耗一个配额
    this.minuteCount++;
    this.hourCount++;
  }
}

// 带速率控制与重试的删除函数
async function deleteAssetWithRetry(octokit, { owner, repo, asset }, limiter) {
  await limiter.waitForSlot();   // 遵守自定限额

  try {
    await octokit.request(
      "DELETE /repos/{owner}/{repo}/releases/assets/{asset_id}",
      { owner, repo, asset_id: asset.id }
    );
    core.info(`Deleted: ${asset.name}`);
  } catch (error) {
    if (error.status === 429) {
      const retryAfter = error.response?.headers?.['retry-after']
        ? parseInt(error.response.headers['retry-after'], 10) * 1000
        : 5_000;   // 默认 5 秒

      core.warning(`Rate limited (429). Waiting ${retryAfter / 1000}s before retrying ${asset.name}`);
      await delay(retryAfter);
      // 重试一次（不再等待 slot，因为刚刚等过了）
      await octokit.request(
        "DELETE /repos/{owner}/{repo}/releases/assets/{asset_id}",
        { owner, repo, asset_id: asset.id }
      );
      core.info(`Deleted (retry): ${asset.name}`);
    } else {
      throw error;   // 其他错误直接抛出
    }
  }
}

async function main() {
  const tag = core.getInput("tag") || (await getVersionFromPackageJson());
  const tagPrefix = core.getInput("tagPrefix");
  const deleteOnlyFromDrafts = core.getInput("deleteOnlyFromDrafts");
  const githubToken = core.getInput("github_token");
  const deleteType = core.getInput("deleteType").toLowerCase();
  const { repo, owner } = github.context.repo;

  if (!tag) {
    throw new Error(
      "Missing value for 'tag'. Was not specified and failed to read from package.json"
    );
  }

  if (!githubToken) {
    throw new Error(
      "GitHub Access Token was not specified but is required for this action!"
    );
  }

  const octokit = new Octokit({ auth: githubToken });

  core.info("Getting releases...");
  const { data: releases } = await octokit.request(
    `GET /repos/{owner}/{repo}/releases`,
    { owner, repo }
  );
  const release = releases.find((r) => r.tag_name === `${tagPrefix}${tag}`);

  if (!release) {
    core.notice(`No release for tag ${tagPrefix}${tag} found.`);
    return;
  }
  core.info(`Release ${release.tag_name} found.`);

  if (deleteOnlyFromDrafts === "true" && !release.draft) {
    core.notice(
      `Not deleting assets because ${release.tag_name} is not a draft.`
    );
    return;
  }

  core.info(`Found ${release.assets.length} assets.`);

  switch (deleteType) {
    case "release":
      await octokit.request("DELETE /repos/{owner}/{repo}/releases/{release_id}", {
        owner,
        repo,
        release_id: release.id,
      });
      break;   // ← 必须加

    case "asset": {
      const limiter = new RateLimiter(75, 450);  // 安全余量
      const assets = release.assets;
      // 每次并发 5 个，避免突发请求
      const concurrency = 5;
      for (let i = 0; i < assets.length; i += concurrency) {
        const batch = assets.slice(i, i + concurrency);
        await Promise.all(
          batch.map(asset =>
            deleteAssetWithRetry(octokit, { owner, repo, asset }, limiter)
          )
        );
      }
      break;
}

    default:
      core.setFailed(`Invalid deleteType: ${deleteType}. Must be "release" or "asset".`);
  }

  core.info("Done.");
}

function getVersionFromPackageJson() {
  core.info("Input 'tag' not specified. Reading version from package.json");

  return new Promise((res) => {
    fs.readFile("./package.json", "utf-8", (err, data) => {
      if (err) throw new Error(err.message);
      else res(JSON.parse(data).version);
    });
  });
}
