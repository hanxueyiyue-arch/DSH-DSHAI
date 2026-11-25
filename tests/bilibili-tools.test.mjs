// 注入改造 ①→②→③ 的验证：
//   ① read_video 的描述要说清"这只是元信息，内容要用 subtitles"
//   ② readVideo 返回值要带 next 指引
//   ③ readSubtitles 要返回 nextFrom（截断时给续读起点，不截断时给 null）
// 全部 mock，不联网；DSH_HOME 指向临时目录，不碰线上 dsh-dshai 数据。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'dsh-bili-test-'));
process.env.DSH_HOME = HOME;

const PKG = '../packages/bilibili/lib/';
const toolsSrc = readFileSync(new URL(PKG + 'tools.js', import.meta.url), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra); }
};

// ---------- mock 依赖 ----------
const SUB_COUNT = 200;
const SUB_STEP = 5;
const subtitleBody = {
  body: Array.from({ length: SUB_COUNT }, (_, i) => ({
    from: i * SUB_STEP,
    to: i * SUB_STEP + SUB_STEP - 1,
    content: `第${i}句字幕内容`,
  })),
};

function makeClient() {
  return {
    view: async () => ({
      bvid: 'BV1xxxxxxxxx', aid: 1, cid: 111, durationSeconds: 1000, title: '测试视频标题', description: '这是一段简介',
      owner: { name: 'UP主', mid: 1 }, url: 'https://example/v', tname: '科普', stats: { view: 1 },
    }),
    comments: async () => [{ content: '评论一' }, { content: '评论二' }],
    player: async () => ({
      cid: 111, duration: 1000,
      subtitles: [{ lan: 'zh-CN', lan_doc: '中文', subtitle_url: 'https://example/sub.json' }],
    }),
    subtitleBody: async () => subtitleBody,
  };
}

const account = {
  requireContentAccess: async () => true,
  hasContentAccess: () => true,
  credentials: () => ({ sessdata: 'mock' }),
  loginStatus: () => ({ status: 'success', account: { mid: '123' } }),
};
const operations = { execute: (_id, input, _caller, handler) => handler(input) };

const { createBilibiliService } = await import(new URL(PKG + 'service.js', import.meta.url));
const { readVideo } = await import(new URL(PKG + 'observation.js', import.meta.url));

const service = createBilibiliService({ client: makeClient(), account, operations, fishName: '助手' });

// ---------- ① 描述 ----------
const descLine = toolsSrc.split('\n').find(l => l.includes("name: 'dshai_read_video'"));
const desc = descLine ?? '';
const descFull = toolsSrc.slice(toolsSrc.indexOf("name: 'dshai_read_video'"), toolsSrc.indexOf("name: 'dshai_draft_comment'"));
check('① 描述提到"元信息"', /元信息/.test(descFull));
check('① 描述点名 dshai_subtitles', /dshai_subtitles/.test(descFull));
check('① 描述说明拿不到视频内容', /拿不到视频讲了什么|看不到视频内容|没有视频内容/.test(descFull), descFull.slice(0, 200));
check('① 描述提到分段续读', /from\/to|按秒分段/.test(descFull));

// ---------- ② readVideo 返回 next ----------
const video = await readVideo({ bvid: 'BV1xxxxxxxxx', client: makeClient() });
check('② readVideo 保留原有字段', video.bvid === 'BV1xxxxxxxxx' && Array.isArray(video.comments) && video.comments.length === 2);
check('② readVideo 带 next 字段', typeof video.next === 'string' && video.next.length > 0);
check('② next 指向 dshai_subtitles', /dshai_subtitles/.test(String(video.next)));
check('② next 提示可续读', /from/.test(String(video.next)));
check('② limitation 未被覆盖', /不是对画面或声音的真实理解/.test(String(video.limitation)));

// ---------- ③ readSubtitles.nextFrom ----------
// 3a 不截断：maxChars 12000 足够放下 200 句
const full = await service.readSubtitles({ bvid: 'BV1xxxxxxxxx', maxChars: 12000 });
check('③a 不截断时 truncated=false', full.truncated === false, `truncated=${full.truncated}`);
check('③a 不截断时 nextFrom=null', full.nextFrom === null, `nextFrom=${JSON.stringify(full.nextFrom)}`);
check('③a 返回了 items', Array.isArray(full.items) && full.items.length === SUB_COUNT);

// 3b 截断：maxChars 取下限 500
const cut = await service.readSubtitles({ bvid: 'BV1xxxxxxxxx', maxChars: 500 });
const lastTo = cut.items[cut.items.length - 1]?.to;
check('③b 截断时 truncated=true', cut.truncated === true, `truncated=${cut.truncated}`);
check('③b 截断时 nextFrom 是数字', Number.isFinite(cut.nextFrom), `nextFrom=${JSON.stringify(cut.nextFrom)}`);
check('③b nextFrom 等于最后一条的 to', cut.nextFrom === lastTo, `nextFrom=${cut.nextFrom} lastTo=${lastTo}`);
check('③b 返回条数少于总数', cut.items.length < SUB_COUNT);

// 3c 从中间续读：from=500 → 只拿 500 秒之后的，且 nextFrom 继续往前走
const resume = await service.readSubtitles({ bvid: 'BV1xxxxxxxxx', from: 500, maxChars: 500 });
check('③c 续读起点生效（首条 from >= 500）', resume.items[0].from >= 500, `first from=${resume.items[0]?.from}`);
check('③c 续读时 nextFrom > 上一次的起点', Number.isFinite(resume.nextFrom) && resume.nextFrom > 500, `nextFrom=${resume.nextFrom}`);

// 3d 区间读到头（to 限死）：不应留下续读点
const head = await service.readSubtitles({ bvid: 'BV1xxxxxxxxx', from: 0, to: 60, maxChars: 12000 });
check('③d 区间读到头时 truncated=false', head.truncated === false, `truncated=${head.truncated}`);
check('③d 区间读到头时 nextFrom=null', head.nextFrom === null, `nextFrom=${JSON.stringify(head.nextFrom)}`);

// 3e 无字幕：明确返回缺失，不编造
const noSub = createBilibiliService({
  client: { ...makeClient(), player: async () => ({ cid: 111, duration: 100, subtitles: [] }) },
  account, operations,
});
const empty = await noSub.readSubtitles({ bvid: 'BV1xxxxxxxxx' });
check('③e 无字幕时 available=false', empty.available === false);
check('③e 无字幕时 nextFrom=null', empty.nextFrom === null);
check('③e 无字幕时给出原因', empty.reason === 'SUBTITLE_EMPTY', `reason=${empty.reason}`);

// ---------- 收尾 ----------
try { rmSync(HOME, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
